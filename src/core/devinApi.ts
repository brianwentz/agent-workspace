// Minimal Devin v3 API client (pure; injectable fetch). Field names verified
// against https://docs.devin.ai/v3-openapi.yaml (fetched 2026): list is
// GET /v3/organizations/{org_id}/sessions?first=&after= returning
// PaginatedResponse[SessionResponse] = { items, end_cursor, has_next_page, total? }.
// The org id comes from GET /v3/self (PatUserSelf / ServiceUserSelf .org_id).

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal | null | undefined },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type DevinSessionStatus =
  | 'new'
  | 'claimed'
  | 'running'
  | 'exit'
  | 'error'
  | 'suspended'
  | 'resuming'
  | (string & {});

export interface DevinPullRequest {
  pr_url: string;
  pr_state: string | null;
}

export interface DevinSession {
  session_id: string;
  title: string | null;
  status: DevinSessionStatus;
  status_detail: string | null;
  created_at: number;
  updated_at: number;
  url?: string | undefined;
  user_id: string | null;
  service_user_id: string | null;
  // Bare id of the session that spawned this one (v3 `parent_session_id`), or
  // null for a top-level session. Optional so hand-built literals can omit it.
  parent_session_id?: string | null;
  pull_requests: DevinPullRequest[];
}

export interface SessionsPage {
  sessions: DevinSession[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface SelfInfo {
  principalType: string | null;
  orgId: string | null;
  userId: string | null;
}

export type DevinApiErrorKind = 'auth' | 'forbidden' | 'rateLimited' | 'http' | 'network' | 'parse';

// Which call produced the error — lets the poller tell "the token was
// rejected" ('self'/'list') apart from a single-session lookup failure.
export type DevinApiOp = 'self' | 'list' | 'session';

export class DevinApiError extends Error {
  readonly kind: DevinApiErrorKind;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  readonly op: DevinApiOp | null;

  constructor(
    kind: DevinApiErrorKind,
    message: string,
    options: { status?: number | null; retryAfterMs?: number | null; op?: DevinApiOp | null } = {},
  ) {
    super(message);
    this.name = 'DevinApiError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.op = options.op ?? null;
  }
}

// Retry-After may be delta-seconds or an HTTP date. Returns ms (>= 0) or null.
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// v3 ids may carry the `devin-` prefix; tab scopes use the bare id.
function bareId(value: string | null): string | null {
  if (!value) return null;
  const id = value.startsWith('devin-') ? value.slice('devin-'.length) : value;
  return id || null;
}

export function normalizeSession(raw: unknown): DevinSession | null {
  const record = asRecord(raw);
  if (!record) return null;
  const sessionId = str(record.session_id);
  const status = str(record.status);
  if (!sessionId || !status) return null;
  const timestamp = (value: unknown): number =>
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value) || 0
        : 0;
  const updatedAt = timestamp(record.updated_at);
  const createdAt = timestamp(record.created_at);
  const prs = Array.isArray(record.pull_requests) ? record.pull_requests : [];
  const pullRequests: DevinPullRequest[] = [];
  for (const item of prs) {
    const pr = asRecord(item);
    const url = pr ? str(pr.pr_url) ?? str(pr.url) : null;
    if (!url) continue;
    pullRequests.push({ pr_url: url, pr_state: pr ? str(pr.pr_state) ?? str(pr.state) : null });
  }
  return {
    session_id: sessionId,
    title: str(record.title),
    status,
    status_detail: str(record.status_detail),
    created_at: createdAt,
    updated_at: updatedAt,
    url: str(record.url) ?? undefined,
    user_id: str(record.user_id),
    service_user_id: str(record.service_user_id),
    parent_session_id: bareId(str(record.parent_session_id)),
    pull_requests: pullRequests,
  };
}

export interface DevinApiClientOptions {
  apiBase: string;
  token: string;
  fetch: FetchLike;
  timeoutMs?: number;
}

export class DevinApiClient {
  private readonly apiBase: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: DevinApiClientOptions) {
    this.apiBase = options.apiBase.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getSelf(): Promise<SelfInfo> {
    const body = await this.request('/v3/self', 'self');
    const record = asRecord(body);
    return {
      principalType: record ? str(record.principal_type) : null,
      orgId: record ? str(record.org_id) : null,
      userId: record ? str(record.user_id) : null,
    };
  }

  async listSessions(options: {
    orgId: string;
    first?: number;
    cursor?: string | null;
    userIds?: string[];
  }): Promise<SessionsPage> {
    const first = Math.min(200, Math.max(1, Math.floor(options.first ?? 100)));
    const params = new URLSearchParams({ first: String(first) });
    if (options.cursor) params.set('after', options.cursor);
    for (const userId of options.userIds ?? []) params.append('user_ids', userId);
    const path = `/v3/organizations/${encodeURIComponent(options.orgId)}/sessions?${params}`;
    const body = await this.request(path, 'list');
    const record = asRecord(body);
    if (!record) throw new DevinApiError('parse', 'sessions response is not an object', { op: 'list' });
    // Accept `items` (documented) and `sessions` (defensive alias).
    const rawItems = Array.isArray(record.items)
      ? record.items
      : Array.isArray(record.sessions)
        ? record.sessions
        : null;
    if (!rawItems) throw new DevinApiError('parse', 'sessions response has no items array', { op: 'list' });
    const sessions = rawItems
      .map(normalizeSession)
      .filter((item): item is DevinSession => item !== null);
    const nextCursor = str(record.end_cursor) ?? str(record.next_cursor);
    const hasNextPage =
      typeof record.has_next_page === 'boolean' ? record.has_next_page : nextCursor !== null;
    return { sessions, nextCursor: hasNextPage ? nextCursor : null, hasNextPage };
  }

  // GET /v3/organizations/{org}/sessions/{devin_id} — used by service-user
  // identity inference (the observed session's user_id + created_at).
  async getSession(orgId: string, sessionId: string): Promise<DevinSession> {
    const path = `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(sessionId)}`;
    const session = normalizeSession(await this.request(path, 'session'));
    if (!session) throw new DevinApiError('parse', 'session response did not parse', { op: 'session' });
    return session;
  }

  private async request(path: string, op: DevinApiOp): Promise<unknown> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
        },
        signal: controller?.signal,
      });
    } catch (error) {
      throw new DevinApiError('network', sanitizeMessage(String(error), this.token), { op });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const status = response.status;
    if (status === 401) throw new DevinApiError('auth', 'unauthorized', { status, op });
    if (status === 403) throw new DevinApiError('forbidden', 'forbidden', { status, op });
    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      throw new DevinApiError('rateLimited', 'rate limited', { status, retryAfterMs, op });
    }
    const text = await response.text().catch(() => '');
    if (status < 200 || status >= 300) {
      throw new DevinApiError('http', `http ${status}`, { status, op });
    }
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new DevinApiError('parse', 'invalid json', { status, op });
    }
  }
}

// Defensive: make sure an error string can never carry the bearer token.
export function sanitizeMessage(message: string, token: string): string {
  return token && message.includes(token) ? message.split(token).join('[redacted]') : message;
}
