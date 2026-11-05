import { describe, expect, it } from 'vitest';
import { reloadView } from '../../src/core/reloadGuard';

describe('reloadView', () => {
  const none = { tab: false, shell: false, provider: false, analytics: false };
  it.each([
    [{ ...none, tab: true }, 'tab'],
    [{ ...none, shell: true }, 'shell'],
    [{ ...none, provider: true }, 'provider'],
    [{ ...none, analytics: true }, 'analytics'],
    [none, 'other'],
    [{ tab: true, shell: true, provider: true, analytics: true }, 'tab'],
  ] as const)('%o -> %s', (flags, expected) => {
    expect(reloadView(flags)).toBe(expected);
  });
});
