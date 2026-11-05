import { describe, expect, it } from 'vitest';
import {
  actionForPress,
  MARK_ACTION_LABEL,
  MARK_ACTIONS,
  nextPress,
  overlaps,
  PRESS_WINDOW_MS,
  safeEnum,
  loadStartReset,
  processGoneDetail,
  sameRect,
  stackInfo,
  tabHistory,
} from '../../src/core/tabPaintDiag';

const full = { x: 0, y: 0, width: 1400, height: 900 };
const devin = { x: 48, y: 36, width: 680, height: 864 };
const pane = { x: 730, y: 36, width: 670, height: 864 };

describe('overlaps', () => {
  it('needs a shared area', () => {
    expect(overlaps(devin, pane)).toBe(false);
    expect(overlaps(full, pane)).toBe(true);
    expect(overlaps({ x: 0, y: 0, width: 730, height: 900 }, pane)).toBe(false);
    expect(overlaps({ x: 0, y: 0, width: 731, height: 900 }, pane)).toBe(true);
    expect(overlaps({ x: 0, y: 0, width: 0, height: 0 }, pane)).toBe(false);
  });
});

describe('stackInfo', () => {
  it('reports a tab above the shell as uncovered', () => {
    const info = stackInfo([
      { bounds: full, isShell: true, isTab: false },
      { bounds: devin, isShell: false, isTab: false },
      { bounds: pane, isShell: false, isTab: true },
    ]);
    expect(info).toEqual({ attached: true, index: 2, childCount: 3, shellIndex: 0, coveredBy: 0, shellAbove: false });
  });

  it('counts only overlapping views above the tab', () => {
    const info = stackInfo([
      { bounds: full, isShell: false, isTab: false },
      { bounds: pane, isShell: false, isTab: true },
      { bounds: devin, isShell: false, isTab: false },
      { bounds: full, isShell: true, isTab: false },
    ]);
    expect(info).toMatchObject({ index: 1, shellIndex: 3, coveredBy: 1, shellAbove: true });
  });

  it('reports a detached tab', () => {
    const info = stackInfo([{ bounds: full, isShell: true, isTab: false }]);
    expect(info).toEqual({ attached: false, index: -1, childCount: 1, shellIndex: 0, coveredBy: 0, shellAbove: false });
  });
});

describe('sameRect', () => {
  it('compares every field and nulls', () => {
    expect(sameRect(pane, { ...pane })).toBe(true);
    expect(sameRect(pane, { ...pane, height: 863 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(pane, null)).toBe(false);
  });
});

describe('tabHistory', () => {
  const now = 10_000_000;
  it.each([
    [
      'created on attach',
      { now, lastActiveAt: now - 5000, loadedAt: now - 100, shownSinceLoad: false, createdOnAttach: true, wasActive: false },
      { hiddenMs: 0, sinceLoadMs: 100, shownSinceLoad: false, loadedHidden: false, wasActive: false },
    ],
    [
      'preloaded, never shown',
      { now, lastActiveAt: now - 30_000, loadedAt: now - 60_000, shownSinceLoad: false, createdOnAttach: false, wasActive: false },
      { hiddenMs: 30_000, sinceLoadMs: 60_000, shownSinceLoad: false, loadedHidden: true, wasActive: false },
    ],
    [
      'shown, hidden 20 min, re-attach',
      { now, lastActiveAt: now - 1_200_000, loadedAt: now - 3_600_000, shownSinceLoad: true, createdOnAttach: false, wasActive: false },
      { hiddenMs: 1_200_000, sinceLoadMs: 3_600_000, shownSinceLoad: true, loadedHidden: false, wasActive: false },
    ],
    [
      'wasActive with stale lastActiveAt',
      { now, lastActiveAt: now - 9_000_000, loadedAt: now - 9_500_000, shownSinceLoad: true, createdOnAttach: false, wasActive: true },
      { hiddenMs: 0, sinceLoadMs: 9_500_000, shownSinceLoad: true, loadedHidden: false, wasActive: true },
    ],
  ])('%s', (_name, input, expected) => {
    expect(tabHistory(input)).toEqual(expected);
  });
});

describe('processGoneDetail', () => {
  it('keeps type, reason and exitCode only', () => {
    expect(
      processGoneDetail({ type: 'GPU', reason: 'crashed', exitCode: 139, serviceName: 'svc', name: 'GPU Process' }),
    ).toEqual({ type: 'GPU', reason: 'crashed', exitCode: 139 });
  });
});

describe('loadStartReset', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ] as const)('attached=%s paneVisible=%s -> shownSinceLoad=%s', (attached, paneVisible, shown) => {
    expect(loadStartReset({ now: 5000, attached, paneVisible })).toEqual({ loadedAt: 5000, shownSinceLoad: shown });
  });
});

describe('nextPress', () => {
  it('starts at 1', () => {
    expect(nextPress(null, 'a', 1000)).toEqual({ tabId: 'a', count: 1, lastAt: 1000 });
  });

  it('counts the same tab inside the window', () => {
    const one = nextPress(null, 'a', 1000);
    const two = nextPress(one, 'a', 2000);
    expect(two).toEqual({ tabId: 'a', count: 2, lastAt: 2000 });
    expect(nextPress(two, 'a', 3000).count).toBe(3);
  });

  it('restarts at or after the window', () => {
    const prev = { tabId: 'a', count: 2, lastAt: 1000 };
    expect(nextPress(prev, 'a', 1000 + PRESS_WINDOW_MS - 1).count).toBe(3);
    expect(nextPress(prev, 'a', 1000 + PRESS_WINDOW_MS).count).toBe(1);
    expect(nextPress(prev, 'a', 1000 + PRESS_WINDOW_MS + 5).count).toBe(1);
  });

  it('restarts for another tab', () => {
    expect(nextPress({ tabId: 'a', count: 2, lastAt: 1000 }, 'b', 1100)).toEqual({ tabId: 'b', count: 1, lastAt: 1100 });
  });

  it('does not mutate the input', () => {
    const prev = Object.freeze({ tabId: 'a', count: 1, lastAt: 1000 });
    nextPress(prev, 'a', 2000);
    expect(prev).toEqual({ tabId: 'a', count: 1, lastAt: 1000 });
  });

  it('slides the window on every press', () => {
    const p1 = nextPress(null, 'a', 0);
    const p2 = nextPress(p1, 'a', 50_000);
    const p3 = nextPress(p2, 'a', 100_000);
    expect([p1.count, p2.count, p3.count]).toEqual([1, 2, 3]);
  });
});

describe('actionForPress', () => {
  it('climbs the ladder', () => {
    expect(actionForPress(1)).toBe('invalidate');
    expect(actionForPress(2)).toBe('reattach');
    expect(actionForPress(3)).toBe('reload');
    expect(actionForPress(9)).toBe('reload');
  });

  it('has a fixed order and a label per action', () => {
    expect(MARK_ACTIONS).toEqual(['invalidate', 'reattach', 'reload']);
    for (const action of MARK_ACTIONS) expect(MARK_ACTION_LABEL[action]).toMatch(/^[a-z-]+$/);
    expect(MARK_ACTION_LABEL).toEqual({ invalidate: 'repaint', reattach: 're-attach', reload: 'reload' });
  });
});

describe('safeEnum', () => {
  it('passes short lowercase enums', () => {
    expect(safeEnum('visible')).toBe('visible');
    expect(safeEnum('disabled_software')).toBe('disabled_software');
  });

  it('turns anything else into other', () => {
    expect(safeEnum('Foo Bar')).toBe('other');
    expect(safeEnum(5)).toBe('other');
    expect(safeEnum(null)).toBe('other');
    expect(safeEnum('')).toBe('other');
    expect(safeEnum('a'.repeat(40))).toBe('other');
  });
});
