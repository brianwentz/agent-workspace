// Pure part of the blank Linked Context pane diagnostics. The "mark as blank"
// button is the one reliable signal that a pane looks wrong: main snapshots the
// view stack synchronously, logs it, then tries one rung of a ladder (repaint,
// re-attach, reload) picked by a per-tab press counter. The log carries only
// ids, numbers, booleans and fixed enums.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StackChild {
  bounds: Rect;
  isShell: boolean;
  isTab: boolean;
}

export interface StackInfo {
  attached: boolean;
  index: number;
  childCount: number;
  shellIndex: number;
  // Views stacked above the tab whose bounds overlap it (the shell included).
  coveredBy: number;
  shellAbove: boolean;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function stackInfo(children: StackChild[]): StackInfo {
  const index = children.findIndex((child) => child.isTab);
  const shellIndex = children.findIndex((child) => child.isShell);
  const target = children[index];
  if (!target) {
    return { attached: false, index, childCount: children.length, shellIndex, coveredBy: 0, shellAbove: false };
  }
  const tab = target.bounds;
  const above = children.slice(index + 1).filter((child) => overlaps(child.bounds, tab));
  return {
    attached: true,
    index,
    childCount: children.length,
    shellIndex,
    coveredBy: above.length,
    shellAbove: above.some((child) => child.isShell),
  };
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export interface TabHistoryInput {
  now: number;
  lastActiveAt: number;
  loadedAt: number;
  shownSinceLoad: boolean;
  createdOnAttach: boolean;
  wasActive: boolean;
}

export interface TabHistory {
  hiddenMs: number;
  sinceLoadMs: number;
  shownSinceLoad: boolean;
  loadedHidden: boolean;
  wasActive: boolean;
  paneHiddenMs?: number;
}

export function tabHistory(i: TabHistoryInput): TabHistory {
  return {
    hiddenMs: i.createdOnAttach || i.wasActive ? 0 : i.now - i.lastActiveAt,
    sinceLoadMs: i.now - i.loadedAt,
    shownSinceLoad: i.shownSinceLoad,
    loadedHidden: !i.createdOnAttach && !i.shownSinceLoad,
    wasActive: i.wasActive,
  };
}

export interface LoadStartInput {
  now: number;
  // The tab's view is the attached active view.
  attached: boolean;
  // The pane has non-empty bounds.
  paneVisible: boolean;
}

// Tab load bookkeeping reset at the start of every main-frame load.
export function loadStartReset(i: LoadStartInput): { loadedAt: number; shownSinceLoad: boolean } {
  return { loadedAt: i.now, shownSinceLoad: i.attached && i.paneVisible };
}

// Structural subset of Electron's child-process-gone Details (core stays electron-free).
export interface ProcessGoneInput {
  type: string;
  reason: string;
  exitCode: number;
  serviceName?: string;
  name?: string;
}

export function processGoneDetail(d: ProcessGoneInput): { type: string; reason: string; exitCode: number } {
  return { type: d.type, reason: d.reason, exitCode: d.exitCode };
}

export const MARK_ACTIONS = ['invalidate', 'reattach', 'reload'] as const;
export type MarkAction = (typeof MARK_ACTIONS)[number];

export const MARK_ACTION_LABEL: Record<MarkAction, string> = {
  invalidate: 'repaint',
  reattach: 're-attach',
  reload: 'reload',
};

export const PRESS_WINDOW_MS = 60_000;

export interface PressState {
  tabId: string;
  count: number;
  lastAt: number;
}

// +1 for the same tab less than `windowMs` after the previous press, else 1.
// `lastAt` slides on every press.
export function nextPress(prev: PressState | null, tabId: string, now: number, windowMs = PRESS_WINDOW_MS): PressState {
  const count = prev && prev.tabId === tabId && now - prev.lastAt < windowMs ? prev.count + 1 : 1;
  return { tabId, count, lastAt: now };
}

export function actionForPress(count: number): MarkAction {
  if (count <= 1) return 'invalidate';
  if (count === 2) return 'reattach';
  return 'reload';
}

// Free strings from outside (Chromium status values) only reach the log as a short lowercase enum.
export function safeEnum(value: unknown): string {
  return typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : 'other';
}
