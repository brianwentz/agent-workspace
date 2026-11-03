// Diagnostics for the "Linked Context tab is blank until its title is clicked"
// bug. A click on the tab that is already active is the user's workaround, so
// that click is the moment the pane is known to look wrong: before re-attaching,
// main snapshots the view stack and the on-screen pixels of the pane. These
// helpers are the pure part of that snapshot; the log carries only the numbers
// and booleans they return.

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

// The tab's rect in screen pixels of the captured display image, inset by
// `inset` DIPs (keeps scrollbars/borders out of the sample) and clamped to the
// image. Null when nothing is left to sample.
export function captureRect(
  contentBounds: Rect,
  viewBounds: Rect,
  displayBounds: Rect,
  scaleFactor: number,
  image: { width: number; height: number },
  inset = 16,
): Rect | null {
  const left = (contentBounds.x - displayBounds.x + viewBounds.x + inset) * scaleFactor;
  const top = (contentBounds.y - displayBounds.y + viewBounds.y + inset) * scaleFactor;
  const right = left + (viewBounds.width - 2 * inset) * scaleFactor;
  const bottom = top + (viewBounds.height - 2 * inset) * scaleFactor;
  const x = Math.max(0, Math.round(left));
  const y = Math.max(0, Math.round(top));
  const width = Math.min(image.width, Math.round(right)) - x;
  const height = Math.min(image.height, Math.round(bottom)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export interface PixelStats {
  samples: number;
  // Share of pixels matching the view/shell background (#111827): the blank pane.
  bgFraction: number;
  // Share of dark pixels (luma < 48) — tells a blank pane from a dark-themed page.
  darkFraction: number;
  // Share of pixels equal to the most common sampled colour.
  uniformFraction: number;
  // The most common sampled colour as #rrggbb (first to reach the top count wins ties); null without samples.
  topColour: string | null;
}

export const PANE_BG = { r: 0x11, g: 0x18, b: 0x27 };

// `bitmap` is BGRA (nativeImage.toBitmap()); every `step`-th pixel is sampled.
export function pixelStats(bitmap: Uint8Array, step = 7, bg = PANE_BG, tolerance = 10): PixelStats {
  let samples = 0;
  let bgCount = 0;
  let darkCount = 0;
  const colours = new Map<number, number>();
  let top = 0;
  let topKey = -1;
  for (let i = 0; i + 3 < bitmap.length; i += 4 * step) {
    const b = bitmap[i] ?? 0;
    const g = bitmap[i + 1] ?? 0;
    const r = bitmap[i + 2] ?? 0;
    samples++;
    if (Math.abs(r - bg.r) <= tolerance && Math.abs(g - bg.g) <= tolerance && Math.abs(b - bg.b) <= tolerance)
      bgCount++;
    if (0.299 * r + 0.587 * g + 0.114 * b < 48) darkCount++;
    const key = (r << 16) | (g << 8) | b;
    const count = (colours.get(key) ?? 0) + 1;
    colours.set(key, count);
    if (count > top) {
      top = count;
      topKey = key;
    }
  }
  const frac = (n: number) => (samples ? Math.round((n / samples) * 100) / 100 : 0);
  return {
    samples,
    bgFraction: frac(bgCount),
    darkFraction: frac(darkCount),
    uniformFraction: frac(top),
    topColour: topKey < 0 ? null : `#${topKey.toString(16).padStart(6, '0')}`,
  };
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

// The renderer's own last frame (webContents.capturePage), inset like the
// screen capture. `inset` is in DIPs; `image` is the captured bitmap size,
// whose ratio to the view width is the frame's device scale.
export function frameRect(
  viewSize: { width: number; height: number },
  image: { width: number; height: number },
  inset = 16,
): Rect | null {
  if (viewSize.width <= 0 || image.width <= 0) return null;
  const scale = image.width / viewSize.width;
  const x = Math.round(inset * scale);
  const y = Math.round(inset * scale);
  const width = Math.min(image.width, Math.round((viewSize.width - inset) * scale)) - x;
  const height = Math.min(image.height, Math.round((viewSize.height - inset) * scale)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

// Page-side numbers for the blank-pane diagnostics: is the document itself
// empty, or is it full and just not on screen? Counts and sizes only — never
// text, URLs or element names.
export interface PageMetrics {
  visibility: string;
  readyState: string;
  // Every element in the document.
  elements: number;
  // Elements with a non-empty box that intersects the viewport (capped scan).
  inViewport: number;
  // Characters of rendered text in the body (a count, never the text).
  textLength: number;
  scrollHeight: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  hasFocus: boolean;
}

export const PAGE_METRICS_CAP = 20_000;

// Runs in the page (main world, via executeJavaScript). Self-contained.
export const PAGE_METRICS_SCRIPT = `(() => {
  const all = document.getElementsByTagName('*');
  const w = window.innerWidth, h = window.innerHeight;
  let inViewport = 0;
  const n = Math.min(all.length, ${PAGE_METRICS_CAP});
  for (let i = 0; i < n; i++) {
    const r = all[i].getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < h && r.left < w) inViewport++;
  }
  const body = document.body;
  return {
    visibility: document.visibilityState,
    readyState: document.readyState,
    elements: all.length,
    inViewport,
    textLength: body ? (body.innerText || '').length : 0,
    scrollHeight: document.documentElement ? document.documentElement.scrollHeight : 0,
    scrollY: window.scrollY,
    innerWidth: w,
    innerHeight: h,
    devicePixelRatio: window.devicePixelRatio,
    hasFocus: document.hasFocus(),
  };
})()`;

const ENUM_VISIBILITY = new Set(['visible', 'hidden', 'prerender']);
const ENUM_READY = new Set(['loading', 'interactive', 'complete']);

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : -1;
}

// Validates the page's answer: a page can return anything, so only known
// enums and finite numbers survive (no page-controlled string reaches the log).
export function parsePageMetrics(raw: unknown): PageMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const pick = (value: unknown, allowed: Set<string>) =>
    typeof value === 'string' && allowed.has(value) ? value : 'other';
  return {
    visibility: pick(r.visibility, ENUM_VISIBILITY),
    readyState: pick(r.readyState, ENUM_READY),
    elements: num(r.elements),
    inViewport: num(r.inViewport),
    textLength: num(r.textLength),
    scrollHeight: num(r.scrollHeight),
    scrollY: num(r.scrollY),
    innerWidth: num(r.innerWidth),
    innerHeight: num(r.innerHeight),
    devicePixelRatio: num(r.devicePixelRatio),
    hasFocus: r.hasFocus === true,
  };
}

// Baseline snapshots of healthy tabs: at most one per `intervalMs`.
export function baselineDue(lastAt: number, now: number, intervalMs: number): boolean {
  return lastAt === 0 || now - lastAt >= intervalMs;
}
