import { describe, expect, it } from 'vitest';
import type { DevinSession } from '../../src/core/devinApi';
import {
  ACTIVE_POLL_MS,
  IDLE_POLL_MS,
  archivedScopes,
  autoOpenScopes,
  rootSessionId,
  scopeLabel,
  backoffMs,
  catchUpPullRequests,
  effectiveStatus,
  isActive,
  isWaiting,
  newPullRequests,
  pollInterval,
  prMenuLabel,
  prTitle,
  openPullRequests,
  truncateTitle,
} from '../../src/core/notifyModel';
import { badgeLabel, badgeSpec } from '../../src/core/badge';

const make = (id: string, status: string, detail: string | null = null): DevinSession => ({
  session_id: id,
  title: id,
  status,
  status_detail: detail,
  created_at: 0,
  updated_at: 0,
  user_id: null,
  service_user_id: null,
  pull_requests: [],
});

describe('effectiveStatus / isWaiting / isActive', () => {
  it('derives waiting from status_detail case-insensitively and treats blocked as waiting', () => {
    expect(effectiveStatus(make('a', 'running', 'Waiting_For_User'))).toBe('waiting_for_user');
    expect(isWaiting(make('a', 'running', 'waiting_for_approval'))).toBe(true);
    expect(isWaiting(make('a', 'BLOCKED'))).toBe(true);
    expect(isWaiting(make('a', 'running', 'working'))).toBe(false);
    expect(isWaiting(make('a', 'suspended', 'inactivity'))).toBe(false);
  });

  it('counts working/running/claimed/resuming/new as active but not waiting or finished', () => {
    expect(isActive(make('a', 'running', 'working'))).toBe(true);
    expect(isActive(make('a', 'claimed'))).toBe(true);
    expect(isActive(make('a', 'resuming'))).toBe(true);
    expect(isActive(make('a', 'new'))).toBe(true);
    expect(isActive(make('a', 'running', 'waiting_for_user'))).toBe(false);
    expect(isActive(make('a', 'running', 'finished'))).toBe(false);
    expect(isActive(make('a', 'suspended'))).toBe(false);
    expect(isActive(make('a', 'exit'))).toBe(false);
  });
});

describe('pollInterval / backoffMs', () => {
  it('polls fast while any session is active, slow otherwise', () => {
    expect(pollInterval([make('a', 'running', 'working'), make('b', 'suspended')])).toBe(ACTIVE_POLL_MS);
    expect(pollInterval([make('a', 'running', 'waiting_for_user'), make('b', 'exit')])).toBe(IDLE_POLL_MS);
    expect(pollInterval([])).toBe(IDLE_POLL_MS);
    expect(pollInterval([make('a', 'claimed')], { active: 500, idle: 3000 })).toBe(500);
  });

  it('doubles per failure and caps at five minutes', () => {
    expect(backoffMs(1, 10_000)).toBe(10_000);
    expect(backoffMs(2, 10_000)).toBe(20_000);
    expect(backoffMs(3, 10_000)).toBe(40_000);
    expect(backoffMs(20, 10_000)).toBe(300_000);
  });
});

describe('badge spec', () => {
  it('labels 1-9 and 9+', () => {
    expect(badgeLabel(0)).toBe('');
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(9)).toBe('9');
    expect(badgeLabel(10)).toBe('9+');
    expect(badgeLabel(42)).toBe('9+');
  });

  it('sizes the label font from the badge size', () => {
    const one = badgeSpec(3, 24);
    expect(one.label).toBe('3');
    expect(one.fontPx).toBe(Math.round(24 * 0.62));
    const plus = badgeSpec(12, 24);
    expect(plus.label).toBe('9+');
    expect(plus.fontPx).toBe(Math.round(24 * 0.52));
    expect(one.color).toBe('#e01e5a');
  });
});

describe('archivedScopes (P8)', () => {
  const before = [make('s1', 'running'), make('s2', 'running'), make('s3', 'running')];

  it('closes scopes whose session is archived', () => {
    const next = [make('s1', 'archived'), make('s2', 'running'), make('s3', 'running')];
    expect(archivedScopes(before, next, true)).toEqual(['s1']);
    expect(archivedScopes(before, next, false)).toEqual(['s1']);
  });

  it('closes scopes missing from a complete list only', () => {
    const next = [make('s1', 'running'), make('s2', 'running')];
    expect(archivedScopes(before, next, true)).toEqual(['s3']);
    // Partial page: absence just means it fell off page 1 — do not close.
    expect(archivedScopes(before, next, false)).toEqual([]);
    expect(archivedScopes([], next, true)).toEqual([]);
  });
});

describe('scopeLabel (F10)', () => {
  const sessions = [make('abcdef123456', 'running')];
  sessions[0]!.title = 'Fix the flaky test';
  it('uses the session title, short id, or GLOBAL label', () => {
    expect(scopeLabel('abcdef123456', sessions)).toBe('Fix the flaky test');
    expect(scopeLabel('unknown-id-999', sessions)).toBe('Session unknown-');
    expect(scopeLabel('', sessions)).toBe('Outside any session');
  });

  it('truncates long titles at 60 chars', () => {
    const long = [{ ...make('s1', 'running'), title: 'x'.repeat(80) }];
    expect(scopeLabel('s1', long)).toBe(`${'x'.repeat(60)}…`);
  });
});

describe('newPullRequests (F1)', () => {
  const withPrs = (id: string, urls: string[], status = 'running'): DevinSession => ({
    ...make(id, status),
    pull_requests: urls.map((pr_url) => ({ pr_url, pr_state: null })),
  });
  const A = 'https://github.com/acme/widgets/pull/1';
  const B = 'https://github.com/acme/widgets/pull/2';
  const C = 'https://github.com/acme/gadgets/pull/7';

  it.each([
    {
      name: 'first poll (no previous) is a baseline',
      previous: [] as DevinSession[],
      next: [withPrs('s1', [A])],
      expected: [],
    },
    {
      name: 'a PR added to a known session is reported',
      previous: [withPrs('s1', [])],
      next: [withPrs('s1', [A])],
      expected: [{ sessionId: 's1', url: A }],
    },
    {
      name: 'a PR removed is not reported',
      previous: [withPrs('s1', [A])],
      next: [withPrs('s1', [])],
      expected: [],
    },
    {
      name: 'the same PR on a now-archived session is not reported',
      previous: [withPrs('s1', [A])],
      next: [withPrs('s1', [A], 'archived')],
      expected: [],
    },
    {
      name: 'a PR appearing on an archived session is not reported',
      previous: [withPrs('s1', [])],
      next: [withPrs('s1', [A], 'archived')],
      expected: [],
    },
    {
      name: 'session reorder changes nothing',
      previous: [withPrs('s1', [A]), withPrs('s2', [B])],
      next: [withPrs('s2', [B]), withPrs('s1', [A])],
      expected: [],
    },
    {
      name: 'two sessions each gaining a PR',
      previous: [withPrs('s1', [A]), withPrs('s2', [])],
      next: [withPrs('s2', [C]), withPrs('s1', [A, B])],
      expected: [
        { sessionId: 's1', url: B },
        { sessionId: 's2', url: C },
      ],
    },
    {
      name: 'a URL-only change reports the new URL',
      previous: [withPrs('s1', [A])],
      next: [withPrs('s1', [B])],
      expected: [{ sessionId: 's1', url: B }],
    },
    {
      name: 'a session first seen in next is a baseline even with PRs',
      previous: [withPrs('s1', [A])],
      next: [withPrs('s1', [A]), withPrs('s2', [B, C])],
      expected: [],
    },
    {
      name: 'the same URL on two sessions is reported once',
      previous: [withPrs('s1', []), withPrs('s2', [])],
      next: [withPrs('s1', [A]), withPrs('s2', [A])],
      expected: [{ sessionId: 's1', url: A }],
    },
  ])('$name', ({ previous, next, expected }) => {
    expect(newPullRequests(previous, next)).toEqual(expected);
  });
});

describe('openPullRequests / prTitle', () => {
  const withPrs = (
    id: string,
    prs: { pr_url: string; pr_state: string | null }[],
    updated_at: number,
    status = 'running',
    title: string | null = id,
  ): DevinSession => ({
    ...make(id, status),
    title,
    updated_at,
    pull_requests: prs,
  });

  it('lists open PRs across sessions ordered by updated_at desc', () => {
    const sessions: DevinSession[] = [
      withPrs('s2', [{ pr_url: 'https://github.com/a/b/pull/7', pr_state: 'open' }], 2),
      withPrs(
        's1',
        [
          { pr_url: 'https://github.com/acme/widgets/pull/42', pr_state: 'open' },
          { pr_url: 'https://example.org/x/y', pr_state: null },
        ],
        3,
        'running',
        'First session',
      ),
    ];
    expect(openPullRequests(sessions)).toEqual([
      {
        sessionId: 's1',
        sessionTitle: 'First session',
        ref: 'acme/widgets#42',
        url: 'https://github.com/acme/widgets/pull/42',
        state: 'open',
      },
      {
        sessionId: 's1',
        sessionTitle: 'First session',
        ref: 'example.org/x/y',
        url: 'https://example.org/x/y',
        state: null,
      },
      {
        sessionId: 's2',
        sessionTitle: 's2',
        ref: 'a/b#7',
        url: 'https://github.com/a/b/pull/7',
        state: 'open',
      },
    ]);
    expect(prTitle('not a url')).toBe('not a url');
  });

  it('skips archived sessions and merged/closed PRs; falls back to the id for blank titles', () => {
    const sessions: DevinSession[] = [
      withPrs(
        'arch',
        [{ pr_url: 'https://github.com/a/b/pull/1', pr_state: 'open' }],
        9,
        'archived',
      ),
      withPrs(
        's1',
        [
          { pr_url: 'https://github.com/a/b/pull/2', pr_state: 'merged' },
          { pr_url: 'https://github.com/a/b/pull/3', pr_state: 'closed' },
          { pr_url: 'https://github.com/a/b/pull/4', pr_state: null },
        ],
        5,
        'running',
        '   ',
      ),
    ];
    expect(openPullRequests(sessions)).toEqual([
      {
        sessionId: 's1',
        sessionTitle: 's1',
        ref: 'a/b#4',
        url: 'https://github.com/a/b/pull/4',
        state: null,
      },
    ]);
  });
});

describe('truncateTitle / prMenuLabel', () => {
  it('returns titles at the limit untouched and truncates with an ellipsis', () => {
    expect(truncateTitle('x'.repeat(64))).toBe('x'.repeat(64));
    expect(truncateTitle('y'.repeat(65))).toBe(`${'y'.repeat(63)}…`);
    expect(truncateTitle('short', 10)).toBe('short');
    expect(truncateTitle('a'.repeat(11), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  it('labels menu items with ref + truncated title, or ref alone', () => {
    expect(prMenuLabel('a/b#1', 'Fix it')).toBe('a/b#1  Fix it');
    expect(prMenuLabel('a/b#1', null)).toBe('a/b#1');
    expect(prMenuLabel('a/b#1', 't'.repeat(70))).toBe(`a/b#1  ${'t'.repeat(63)}…`);
  });
});

describe('catchUpPullRequests', () => {
  const session = (
    id: string,
    prs: { pr_url: string; pr_state: string | null }[],
    updated_at = 0,
    status = 'running',
  ): DevinSession => ({ ...make(id, status), pull_requests: prs, updated_at });

  const A = 'https://github.com/a/b/pull/1';
  const B = 'https://github.com/a/b/pull/2';
  const opts = (over: Partial<{ lastGoodAt: number; now: number; maxAgeMs: number; limit: number }> = {}) => ({
    lastGoodAt: 1_000,
    now: 2_000,
    ...over,
  });

  it('returns unseen open PRs and skips ones the ledger already saw', () => {
    const sessions = [session('s1', [{ pr_url: A, pr_state: 'open' }, { pr_url: B, pr_state: null }])];
    expect(catchUpPullRequests(sessions, new Set(), opts())).toEqual([
      { sessionId: 's1', url: A },
      { sessionId: 's1', url: B },
    ]);
    expect(catchUpPullRequests(sessions, new Set([A]), opts())).toEqual([
      { sessionId: 's1', url: B },
    ]);
    expect(catchUpPullRequests(sessions, new Set([A, B]), opts())).toEqual([]);
  });

  it('skips archived sessions and non-open PR states', () => {
    const sessions = [
      session('s1', [{ pr_url: A, pr_state: 'open' }], 0, 'archived'),
      session('s2', [
        { pr_url: B, pr_state: 'closed' },
        { pr_url: 'https://github.com/a/b/pull/3', pr_state: 'merged' },
      ]),
    ];
    expect(catchUpPullRequests(sessions, new Set(), opts())).toEqual([]);
  });

  it('returns [] when the ledger is empty or too old', () => {
    const sessions = [session('s1', [{ pr_url: A, pr_state: 'open' }])];
    expect(catchUpPullRequests(sessions, new Set(), opts({ lastGoodAt: 0 }))).toEqual([]);
    expect(
      catchUpPullRequests(sessions, new Set(), opts({ lastGoodAt: 1_000, now: 1_000 + 100, maxAgeMs: 50 })),
    ).toEqual([]);
  });

  it('orders by session updated_at desc and respects the limit', () => {
    const pr = (n: number) => ({ pr_url: `https://github.com/a/b/pull/${n}`, pr_state: 'open' });
    const sessions = [
      session('old', [pr(1), pr(2)], 1),
      session('new', [pr(3), pr(4)], 9),
    ];
    expect(catchUpPullRequests(sessions, new Set(), opts({ limit: 3 }))).toEqual([
      { sessionId: 'new', url: 'https://github.com/a/b/pull/3' },
      { sessionId: 'new', url: 'https://github.com/a/b/pull/4' },
      { sessionId: 'old', url: 'https://github.com/a/b/pull/1' },
    ]);
  });

  it('dedupes a PR URL listed on two sessions', () => {
    const sessions = [
      session('s1', [{ pr_url: A, pr_state: 'open' }], 2),
      session('s2', [{ pr_url: A, pr_state: null }], 1),
    ];
    expect(catchUpPullRequests(sessions, new Set(), opts())).toEqual([{ sessionId: 's1', url: A }]);
  });
});

describe('rootSessionId / autoOpenScopes (sub-session PR tabs)', () => {
  const parents: Record<string, string | null> = { child: 'root', grandchild: 'child', root: null };
  const parentOf = (id: string) => parents[id];

  it('walks parent links to the top-level session', () => {
    expect(rootSessionId('grandchild', parentOf)).toBe('root');
    expect(rootSessionId('child', parentOf)).toBe('root');
    expect(rootSessionId('root', parentOf)).toBe('root');
  });

  it('treats a session missing from the Cloud list as its own root', () => {
    expect(rootSessionId('unknown', parentOf)).toBe('unknown');
  });

  it('stops on a parent cycle instead of looping', () => {
    const cyclic: Record<string, string> = { a: 'b', b: 'a' };
    expect(rootSessionId('a', (id) => cyclic[id])).toBe('b');
  });

  it('opens a sub-session PR in the sub-session and its top-level session', () => {
    expect(autoOpenScopes('grandchild', parentOf)).toEqual(['grandchild', 'root']);
    expect(autoOpenScopes('child', parentOf)).toEqual(['child', 'root']);
  });

  it('opens a top-level or unknown session PR in that session only', () => {
    expect(autoOpenScopes('root', parentOf)).toEqual(['root']);
    expect(autoOpenScopes('unknown', parentOf)).toEqual(['unknown']);
  });
});
