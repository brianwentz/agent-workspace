// Blank Linked Context pane diagnostics. A click on the tab that is already
// active is the user's workaround for a pane that shows only the dark
// background, and a reload is the other one, so before that click re-attaches
// the view (or the reload starts) we record what the window looked like: where the view sits in the stack, its bounds, its
// renderer, and (Windows) the real on-screen pixels of the pane. The log holds
// numbers and booleans only — never the URL, title or pixel data.
import { desktopCapturer, screen, type WebContentsView } from 'electron';
import {
  baselineDue,
  captureRect,
  frameRect,
  PAGE_METRICS_SCRIPT,
  parsePageMetrics,
  pixelStats,
  sameRect,
  stackInfo,
  type PageMetrics,
  type PixelStats,
} from '../core/tabPaintDiag';
import { log } from './log';
import { state, testMode } from './state';

const PAGE_TIMEOUT_MS = 300;
const FRAME_TIMEOUT_MS = 300;
// The click / reload waits for the snapshot at most this long before running.
export const DIAG_BUDGET_MS = 1000;
// Baseline: snapshot the active tab this long after an attach, at most once per interval.
// Test mode: off unless AGENT_WORKSPACE_TEST_BASELINE_MS is set, which replaces
// both (quiet test windows are never focused, so the focus gate is skipped there).
const testBaselineMs = testMode ? Number(process.env.AGENT_WORKSPACE_TEST_BASELINE_MS) : NaN;
const BASELINE_DELAY_MS = Number.isFinite(testBaselineMs) ? testBaselineMs : 3000;
const BASELINE_INTERVAL_MS = Number.isFinite(testBaselineMs) ? testBaselineMs : 60_000;

export type DiagTrigger = 'click-active' | 'reload' | 'marked-blank';

let lastWindowFocusAt = 0;

export function noteWindowFocus(): void {
  lastWindowFocusAt = Date.now();
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

// Numbers from inside the page: an empty document vs a full one that isn't on screen.
async function pageMetrics(view: WebContentsView): Promise<PageMetrics | { error: string }> {
  try {
    const raw = await withTimeout<unknown>(
      view.webContents.executeJavaScript(PAGE_METRICS_SCRIPT, false),
      PAGE_TIMEOUT_MS,
      'timeout',
    );
    if (raw === 'timeout') return { error: 'timeout' };
    return parsePageMetrics(raw) ?? { error: 'shape' };
  } catch {
    return { error: 'error' };
  }
}

// The renderer's own last frame. Content here while the screen shows none means
// the frame never reached the screen (compositing/presentation); no content here
// either means the page painted nothing.
async function framePixels(view: WebContentsView): Promise<PixelStats | { error: string }> {
  try {
    const image = await withTimeout(view.webContents.capturePage(), FRAME_TIMEOUT_MS, null);
    if (!image) return { error: 'timeout' };
    if (image.isEmpty()) return { error: 'empty' };
    const rect = frameRect(view.getBounds(), image.getSize());
    if (!rect) return { error: 'empty-rect' };
    return pixelStats(image.crop(rect).toBitmap());
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

// Desktop capture is Windows-only here: on macOS it would raise the
// screen-recording permission prompt.
async function panePixels(view: WebContentsView): Promise<PixelStats | { error: string } | null> {
  if (process.platform !== 'win32' || !state.windowRef) return null;
  try {
    const contentBounds = state.windowRef.getContentBounds();
    const viewBounds = view.getBounds();
    const display = screen.getDisplayMatching({
      x: contentBounds.x + viewBounds.x,
      y: contentBounds.y + viewBounds.y,
      width: viewBounds.width,
      height: viewBounds.height,
    });
    const size = {
      width: Math.round(display.bounds.width * display.scaleFactor),
      height: Math.round(display.bounds.height * display.scaleFactor),
    };
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) return { error: 'no-source' };
    const image = source.thumbnail;
    const rect = captureRect(contentBounds, viewBounds, display.bounds, display.scaleFactor, image.getSize());
    if (!rect) return { error: 'empty-rect' };
    return pixelStats(image.crop(rect).toBitmap());
  } catch (error) {
    return { error: error instanceof Error ? error.name : 'unknown' };
  }
}

type DiagEvent = 'tab-reactivate-diag' | 'tab-paint-baseline';

// Snapshots the active tab and logs `event`. Never rejects.
async function snapshotActiveTab(event: DiagEvent, trigger: DiagTrigger | 'baseline'): Promise<void> {
  const started = Date.now();
  const { windowRef, shellView, tabManager } = state;
  const view = tabManager?.activeView ?? null;
  if (!windowRef || !tabManager || !view) return;
  try {
    // Synchronous part first: nothing may restack between the click and this.
    const children = windowRef.contentView.children;
    const stack = stackInfo(
      children.map((child) => ({
        bounds: child.getBounds(),
        isShell: child === shellView,
        isTab: child === view,
      })),
    );
    const bounds = view.getBounds();
    const expected = tabManager.expectedBounds;
    const contents = view.webContents;
    const history = tabManager.lastAttachHistory;
    const sync = {
      trigger,
      id: tabManager.activeId,
      history: history ? { ...history } : null,
      ...stack,
      width: bounds.width,
      height: bounds.height,
      boundsMatch: sameRect(bounds, expected),
      paneVisible: expected !== null,
      viewVisible: view.getVisible(),
      destroyed: contents.isDestroyed(),
      crashed: !contents.isDestroyed() && contents.isCrashed(),
      loading: !contents.isDestroyed() && contents.isLoading(),
      windowFocused: windowRef.isFocused(),
      windowMinimized: windowRef.isMinimized(),
      sinceAttachMs: tabManager.lastAttachedAt ? started - tabManager.lastAttachedAt : null,
      sinceWindowFocusMs: lastWindowFocusAt ? started - lastWindowFocusAt : null,
      surface: state.surface,
    };
    // Sequential, screen first: it is the closest to what the user saw, and the
    // page script forces a layout that could change it. *At = ms after `started`
    // each part began — past DIAG_BUDGET_MS the click / reload has already run.
    const captureStarted = Date.now();
    const pixels = await panePixels(view);
    const captureMs = Date.now() - captureStarted;
    const pageAt = Date.now() - started;
    const page = contents.isDestroyed() ? { error: 'destroyed' } : await pageMetrics(view);
    const frameAt = Date.now() - started;
    const frame = contents.isDestroyed() ? { error: 'destroyed' } : await framePixels(view);
    const visibility = 'visibility' in page ? page.visibility : page.error;
    log('shell', event, {
      detail: {
        ...sync,
        visibility,
        pixels,
        captureMs,
        page,
        pageAt,
        frame,
        frameAt,
        ms: Date.now() - started,
      },
    });
  } catch (error) {
    log('shell', event, {
      detail: { trigger, id: tabManager.activeId, error: error instanceof Error ? error.name : 'unknown', ms: Date.now() - started },
    });
  }
}

// Logs `tab-reactivate-diag` for the active tab. Never rejects.
export function diagnoseActiveTab(trigger: DiagTrigger): Promise<void> {
  return snapshotActiveTab('tab-reactivate-diag', trigger);
}

// The "mark as blank" button: the user says the active tab looks blank right
// now. Snapshot it as-is — no re-attach, so a click afterwards still shows
// whether re-attaching fixes it (and logs its own click-active diag).
export function markActiveTabBlank(): void {
  const id = state.tabManager?.activeId ?? null;
  log('shell', 'tab-blank-marked', { detail: { id } });
  void diagnoseActiveTab('marked-blank');
}

let baselineTimer: NodeJS.Timeout | null = null;
let lastBaselineAt = 0;

// After an attach, snapshot the tab a few seconds later as `tab-paint-baseline`
// (throttled) — the healthy numbers the blank-pane diags are compared against.
export function scheduleBaseline(tabId: string): void {
  if (testMode && !Number.isFinite(testBaselineMs)) return;
  if (baselineTimer) clearTimeout(baselineTimer);
  baselineTimer = setTimeout(() => {
    baselineTimer = null;
    const tabManager = state.tabManager;
    if (!tabManager || tabManager.activeId !== tabId || !tabManager.activeView) return;
    if (tabManager.expectedBounds === null) return;
    if (!testMode && !state.windowRef?.isFocused()) return;
    const now = Date.now();
    if (!baselineDue(lastBaselineAt, now, BASELINE_INTERVAL_MS)) return;
    lastBaselineAt = now;
    void snapshotActiveTab('tab-paint-baseline', 'baseline');
  }, BASELINE_DELAY_MS);
  baselineTimer.unref?.();
}

// Runs the active-tab diagnostics, then `then` exactly once: when they finish
// (or throw) or after DIAG_BUDGET_MS, whichever comes first.
export function withActiveTabDiag(trigger: DiagTrigger, then: () => void): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    then();
  };
  const timer = setTimeout(finish, DIAG_BUDGET_MS);
  void diagnoseActiveTab(trigger)
    .catch(() => undefined)
    .finally(finish);
}

// The normal activation after a tab click. Only a click on the already-active
// tab is diagnosed.
export function withReactivateDiag(tabId: string, then: () => void): void {
  if (state.tabManager?.activeId !== tabId) {
    then();
    return;
  }
  withActiveTabDiag('click-active', then);
}
