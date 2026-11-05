// Blank Linked Context pane diagnostics, driven by the "mark as blank" button.
// A press snapshots the pane synchronously (before anything is touched), logs
// it, then runs one rung of a ladder picked by a per-tab press counter:
// repaint, re-attach, reload. The log holds ids, numbers, booleans and fixed
// enums only — never the URL, title or page content. No screen or frame
// capture of any kind (on macOS desktop capture raises the screen-recording prompt).
import { app, screen } from 'electron';
import {
  actionForPress,
  nextPress,
  safeEnum,
  sameRect,
  stackInfo,
  type MarkAction,
  type PressState,
} from '../core/tabPaintDiag';
import { log } from './log';
import { state } from './state';

let lastWindowFocusAt = 0;
let lastResumeAt = 0;
let lastUnlockAt = 0;
let lastPress: PressState | null = null;

export function noteWindowFocus(): void {
  lastWindowFocusAt = Date.now();
}

export function notePowerEvent(kind: 'resume' | 'unlock'): void {
  if (kind === 'resume') lastResumeAt = Date.now();
  else lastUnlockAt = Date.now();
}

// ms since `at`, null until the event happened this run.
function since(at: number, now: number): number | null {
  return at ? now - at : null;
}

// Software compositing is a known blank-pane cause; constant per run.
export function logGpuFeatureStatus(): void {
  try {
    log('shell', 'gpu-feature-status', {
      detail: { gpuCompositing: safeEnum(app.getGPUFeatureStatus().gpu_compositing) },
    });
  } catch {
    // Diagnostic only: never block window creation.
  }
}

export interface MarkDeps {
  // The click-active body: tabManager.activate(id) + applyLayout().
  reattach(id: string): void;
  reload(contents: Electron.WebContents): void;
}

// The "mark as blank" button: the user says the active tab looks blank right now.
export function markActiveTabBlank(deps: MarkDeps): void {
  const { windowRef, shellView, tabManager } = state;
  const view = tabManager?.activeView ?? null;
  const id = tabManager?.activeId ?? null;
  if (!windowRef || !tabManager || !view || !id) return;
  const now = Date.now();
  const press = nextPress(lastPress, id, now);
  const sincePrevPressMs = lastPress && lastPress.tabId === id ? now - lastPress.lastAt : null;
  lastPress = press;
  const action: MarkAction = actionForPress(press.count);

  // Everything below up to the log is synchronous: nothing may restack between the press and the snapshot.
  const contents = view.webContents;
  const destroyed = contents.isDestroyed();
  const stack = stackInfo(
    windowRef.contentView.children.map((child) => ({
      bounds: child.getBounds(),
      isShell: child === shellView,
      isTab: child === view,
    })),
  );
  const bounds = view.getBounds();
  const expected = tabManager.expectedBounds;
  const history = tabManager.lastAttachHistory;
  const display = screen.getDisplayMatching(windowRef.getBounds());
  const snapshot = {
    history: history ? { ...history } : null,
    ...stack,
    width: bounds.width,
    height: bounds.height,
    boundsMatch: sameRect(bounds, expected),
    paneVisible: expected !== null,
    viewVisible: view.getVisible(),
    frameVisibility: destroyed ? 'other' : safeEnum(contents.mainFrame.visibilityState),
    destroyed,
    crashed: !destroyed && contents.isCrashed(),
    loading: !destroyed && contents.isLoading(),
    windowFocused: windowRef.isFocused(),
    windowMinimized: windowRef.isMinimized(),
    windowVisible: windowRef.isVisible(),
    scaleFactor: display.scaleFactor,
    displays: screen.getAllDisplays().length,
    surface: state.surface,
    sinceAttachMs: since(tabManager.lastAttachedAt, now),
    sinceWindowFocusMs: since(lastWindowFocusAt, now),
    sinceScopeSwitchMs: since(tabManager.lastScopeSwitchAt, now),
    sinceTabCloseMs: since(tabManager.lastCloseAt, now),
    sinceResumeMs: since(lastResumeAt, now),
    sinceUnlockMs: since(lastUnlockAt, now),
  };

  let applied = false;
  let skipped: 'destroyed' | undefined;
  let error: string | undefined;
  if (destroyed) {
    skipped = 'destroyed';
  } else {
    try {
      if (action === 'invalidate') contents.invalidate();
      else if (action === 'reattach') deps.reattach(id);
      else deps.reload(contents);
      applied = true;
    } catch (caught) {
      error = caught instanceof Error ? caught.name : 'unknown';
    }
  }
  log('shell', 'tab-blank-marked', {
    detail: {
      id,
      press: press.count,
      action,
      applied,
      ...(skipped ? { skipped } : {}),
      ...(error ? { error } : {}),
      sincePrevPressMs,
      ...snapshot,
    },
  });
}
