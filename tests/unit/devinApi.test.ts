import { describe, expect, it } from 'vitest';
import {
  DevinApiClient,
  DevinApiError,
  normalizeSession,
  parseRetryAfter,
  sanitizeMessage,
  type FetchLike,
} from '../../src/core/devinApi';

type Call = { url: string; headers: Record<string, string> };

function stubFetch(
  handler: (url: string, calls: Call[]) => { status: number; body?: unknown; headers?: Record<string, string> },
): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const result = handler(url, calls);
    const headers = new Map(Object.entries(result.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      status: result.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
    };
  };
  return { fetch, calls };
}

const session = (id: string, extra: Record<string, unknown> = {}) => ({
  session_id: id,
  url: `https://app.devin.ai/sessions/${id}`,
  status: 'running',
  status_detail: 'working',
  tags: [],
  org_id: 'org-1',
  created_at: 1,
  updated_at: 2,
  acus_consumed: 0,
  pull_requests: [],
  ...extra,
});

describe('DevinApiClient', () => {
  it('sends the bearer token and resolves the org id from /v3/self', async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: { principal_type: 'pat_user', org_id: 'org-abc', user_id: 'u', user_name: 'n' },
    }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai/', token: 'tok-123456789', fetch });
    const self = await client.getSelf();
    expect(self).toEqual({ principalType: 'pat_user', orgId: 'org-abc', userId: 'u' });
    expect(calls[0]?.url).toBe('https://api.devin.ai/v3/self');
    expect(calls[0]?.headers.authorization).toBe('Bearer tok-123456789');
  });

  it('paginates with first/after and maps items, end_cursor and has_next_page', async () => {
    const { fetch, calls } = stubFetch((url) => {
      const params = new URL(url).searchParams;
      if (!params.get('after')) {
        return {
          status: 200,
          body: { items: [session('a'), session('b')], end_cursor: 'cur-1', has_next_page: true },
        };
      }
      return { status: 200, body: { items: [session('c')], end_cursor: null, has_next_page: false } };
    });
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const page1 = await client.listSessions({ orgId: 'org-1', first: 2 });
    expect(page1.sessions.map((s) => s.session_id)).toEqual(['a', 'b']);
    expect(page1.nextCursor).toBe('cur-1');
    expect(calls[0]?.url).toBe('https://api.devin.ai/v3/organizations/org-1/sessions?first=2');
    const page2 = await client.listSessions({ orgId: 'org-1', first: 2, cursor: page1.nextCursor });
    expect(page2.sessions.map((s) => s.session_id)).toEqual(['c']);
    expect(page2.nextCursor).toBeNull();
    expect(page2.hasNextPage).toBe(false);
    expect(calls[1]?.url).toContain('after=cur-1');
  });

  it('serializes userIds as repeated user_ids params and maps service-user self without a userId', async () => {
    const { fetch, calls } = stubFetch((url) => {
      if (url.endsWith('/v3/self')) {
        return {
          status: 200,
          body: { principal_type: 'service_user', service_user_id: 'svc-1', org_id: 'org-1' },
        };
      }
      return { status: 200, body: { items: [] } };
    });
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const self = await client.getSelf();
    expect(self.userId).toBeNull();
    await client.listSessions({ orgId: 'org-1', userIds: ['u1', 'u2'] });
    const params = new URL(calls[1]!.url).searchParams;
    expect(params.getAll('user_ids')).toEqual(['u1', 'u2']);
    expect(calls[1]!.url).toContain('user_ids=u1');
  });

  it('clamps first to the documented 1..200 range', async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { items: [] } }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    await client.listSessions({ orgId: 'o', first: 999 });
    expect(calls[0]?.url).toContain('first=200');
  });

  it('tags errors with the failing operation', async () => {
    const forbidden = stubFetch(() => ({ status: 403 }));
    const clientA = new DevinApiClient({ apiBase: 'x://a', token: 't', fetch: forbidden.fetch });
    const selfError = (await clientA.getSelf().catch((e: unknown) => e)) as DevinApiError;
    expect(selfError.kind).toBe('forbidden');
    expect(selfError.op).toBe('self');

    const server = stubFetch(() => ({ status: 500 }));
    const clientB = new DevinApiClient({ apiBase: 'x://a', token: 't', fetch: server.fetch });
    const listError = (await clientB.listSessions({ orgId: 'o' }).catch((e: unknown) => e)) as DevinApiError;
    expect(listError.kind).toBe('http');
    expect(listError.op).toBe('list');

    const notObject = stubFetch(() => ({ status: 200, body: [1, 2] }));
    const clientC = new DevinApiClient({ apiBase: 'x://a', token: 't', fetch: notObject.fetch });
    const parseError = (await clientC.listSessions({ orgId: 'o' }).catch((e: unknown) => e)) as DevinApiError;
    expect(parseError.kind).toBe('parse');
    expect(parseError.op).toBe('list');
  });

  it('maps 401 to an auth error', async () => {
    const { fetch } = stubFetch(() => ({ status: 401, body: { detail: 'nope' } }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const error = await client.listSessions({ orgId: 'o' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DevinApiError);
    expect((error as DevinApiError).kind).toBe('auth');
    expect((error as DevinApiError).status).toBe(401);
  });

  it('maps 429 with Retry-After seconds to a rateLimited error with retryAfterMs', async () => {
    const { fetch } = stubFetch(() => ({ status: 429, headers: { 'Retry-After': '7' } }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const error = (await client.listSessions({ orgId: 'o' }).catch((e: unknown) => e)) as DevinApiError;
    expect(error.kind).toBe('rateLimited');
    expect(error.retryAfterMs).toBe(7000);
  });

  it('maps thrown fetch errors to network errors without leaking the token', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('ECONNREFUSED while sending Bearer secret-token-xyz');
    };
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 'secret-token-xyz', fetch });
    const error = (await client.getSelf().catch((e: unknown) => e)) as DevinApiError;
    expect(error.kind).toBe('network');
    expect(error.message).not.toContain('secret-token-xyz');
    expect(error.message).toContain('[redacted]');
  });

  it('maps other non-2xx statuses to http errors and bad JSON to parse errors', async () => {
    const a = stubFetch(() => ({ status: 500 }));
    const clientA = new DevinApiClient({ apiBase: 'x://a', token: 't', fetch: a.fetch });
    expect(((await clientA.getSelf().catch((e: unknown) => e)) as DevinApiError).kind).toBe('http');
    const fetchBad: FetchLike = async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => '{not json',
    });
    const clientB = new DevinApiClient({ apiBase: 'x://a', token: 't', fetch: fetchBad });
    expect(((await clientB.getSelf().catch((e: unknown) => e)) as DevinApiError).kind).toBe('parse');
  });
});

describe('normalizeSession', () => {
  it('keeps pr_url/pr_state and tolerates missing optional fields', () => {
    const normalized = normalizeSession(
      session('s1', {
        title: null,
        status_detail: null,
        pull_requests: [{ pr_url: 'https://github.com/o/r/pull/1', pr_state: 'open' }, { bogus: 1 }],
      }),
    );
    expect(normalized).toEqual({
      session_id: 's1',
      title: null,
      status: 'running',
      status_detail: null,
      created_at: 1,
      updated_at: 2,
      url: 'https://app.devin.ai/sessions/s1',
      user_id: null,
      service_user_id: null,
      parent_session_id: null,
      pull_requests: [{ pr_url: 'https://github.com/o/r/pull/1', pr_state: 'open' }],
    });
    expect(normalizeSession({ status: 'running' })).toBeNull();
    expect(normalizeSession('nope')).toBeNull();
  });

  it('keeps parent_session_id as a bare id (sub-session parent link)', () => {
    expect(normalizeSession(session('s3', { parent_session_id: 'devin-abc123' }))?.parent_session_id).toBe('abc123');
    expect(normalizeSession(session('s4', { parent_session_id: 'abc123' }))?.parent_session_id).toBe('abc123');
    expect(normalizeSession(session('s5', { parent_session_id: '' }))?.parent_session_id).toBeNull();
    expect(normalizeSession(session('s6', { parent_session_id: 7 }))?.parent_session_id).toBeNull();
  });

  it('keeps user_id when present', () => {
    expect(normalizeSession(session('s2', { user_id: 'user-9' }))?.user_id).toBe('user-9');
  });

  it('normalizes an ISO created_at to ms and keeps service_user_id', () => {
    const normalized = normalizeSession(
      session('s3', {
        created_at: '2026-01-02T03:04:05Z',
        service_user_id: 'svc-9',
        user_id: 'user-9',
      }),
    );
    expect(normalized?.created_at).toBe(Date.parse('2026-01-02T03:04:05Z'));
    expect(normalized?.service_user_id).toBe('svc-9');
  });
});

describe('getSession', () => {
  it('GETs the single-session path and normalizes the item', async () => {
    const created = '2026-01-02T03:04:05Z';
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: session('sess-9', {
        created_at: created,
        user_id: 'user-9',
        service_user_id: 'svc-9',
      }),
    }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const result = await client.getSession('org-1', 'sess-9');
    expect(calls[0]?.url).toBe(
      'https://api.devin.ai/v3/organizations/org-1/sessions/sess-9',
    );
    expect(result.session_id).toBe('sess-9');
    expect(result.user_id).toBe('user-9');
    expect(result.service_user_id).toBe('svc-9');
    expect(result.created_at).toBe(Date.parse(created));
  });

  it('maps a 404 to an http error with status 404', async () => {
    const { fetch } = stubFetch(() => ({ status: 404, body: { title: 'Not Found' } }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const error = (await client.getSession('org-1', 'nope').catch((e: unknown) => e)) as DevinApiError;
    expect(error).toBeInstanceOf(DevinApiError);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(404);
  });

  it('maps an unparseable body to a parse error', async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: { nope: true } }));
    const client = new DevinApiClient({ apiBase: 'https://api.devin.ai', token: 't', fetch });
    const error = (await client.getSession('org-1', 's').catch((e: unknown) => e)) as DevinApiError;
    expect(error.kind).toBe('parse');
  });
});

describe('parseRetryAfter', () => {
  it('parses delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 00:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('garbage')).toBeNull();
  });
});

describe('sanitizeMessage', () => {
  it('redacts every occurrence of the token', () => {
    expect(sanitizeMessage('a tok b tok', 'tok')).toBe('a [redacted] b [redacted]');
    expect(sanitizeMessage('clean', '')).toBe('clean');
  });
});
