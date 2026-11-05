import { useEffect, useRef, useState } from 'react';
import { RAIL_WIDTH, TITLE_BAR_HEIGHT } from '../../core/layout';
import {
  actionForPress,
  MARK_ACTION_LABEL,
  nextPress,
  type MarkAction,
  type PressState,
} from '../../core/tabPaintDiag';
import type { ShellState } from '../../shared/ipc';
import { NotificationBanner } from './NotificationBanner';
import { TabStrip } from './TabStrip';
import { useTabDrop } from './useTabDrop';
import { AgMark } from './icons/AgMark';
import { StarIcon } from './icons/StarIcon';

type Tab = ShellState['tabs']['tabs'][number];

interface TitleBarProps {
  windowWidth: number;
  paneVisible: boolean;
  paneX: number; // ghTab.x when the pane is visible
  paneWidth: number; // ghTab.width when the pane is visible
  tabs: Tab[];
  activeId: string | null;
}

interface WindowControlsOverlayLike {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
  removeEventListener(type: 'geometrychange', listener: () => void): void;
}

const MARK_COOLDOWN_MS = 1500;
const MARK_BADGE_MS = 2000;

// "The active tab looks blank right now": main snapshots the pane, then tries
// one rung of repaint -> re-attach -> reload per press. The counter here only
// feeds the tooltip and follows main's nextPress rule (per tab, 60 s window); main's log is the record.
function MarkBlankButton({ activeId }: { activeId: string | null }) {
  const [tried, setTried] = useState<MarkAction | null>(null);
  const [marked, setMarked] = useState(false);
  const [cooling, setCooling] = useState(false);
  const press = useRef<PressState | null>(null);
  // Only the tooltip text: the counter itself follows nextPress.
  useEffect(() => {
    setTried(null);
  }, [activeId]);
  useEffect(() => {
    if (!marked) return;
    const timer = setTimeout(() => setMarked(false), MARK_BADGE_MS);
    return () => clearTimeout(timer);
  }, [marked]);
  useEffect(() => {
    if (!cooling) return;
    const timer = setTimeout(() => setCooling(false), MARK_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [cooling]);
  return (
    <button
      id="tabMarkBlank"
      type="button"
      aria-label="Report blank tab"
      title={
        tried
          ? `Tried: ${MARK_ACTION_LABEL[tried]}. Still blank? Press again.`
          : 'This tab looks blank: record diagnostics and try to repaint it'
      }
      data-state={marked ? 'marked' : 'idle'}
      disabled={!activeId || cooling}
      className={`app-no-drag shrink-0 self-center ${navButton}`}
      onClick={() => {
        if (!activeId) return;
        const next = nextPress(press.current, activeId, Date.now());
        press.current = next;
        window.agentworkspace.markTabBlank();
        setTried(actionForPress(next.count));
        setMarked(true);
        setCooling(true);
      }}
    >
      {marked ? '✓' : '⚑'}
    </button>
  );
}

function windowControlsOverlay(): WindowControlsOverlayLike | null {
  const candidate = (navigator as { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay;
  return candidate ?? null;
}

const isMac = window.agentworkspace.platform === 'darwin';

// Width of the strip the OS caption buttons cover on the right. Measured from the
// overlay's titlebar rect when available; 138px is the standard win32 caption width.
// macOS has no caption buttons on the right (traffic lights are on the left).
const OVERLAY_FALLBACK = 138;

function measureOverlayReserve(): number {
  if (isMac) return 0;
  const overlay = windowControlsOverlay();
  if (!overlay) return OVERLAY_FALLBACK;
  const rect = overlay.getTitlebarAreaRect();
  return Math.max(0, Math.round(window.innerWidth - (rect.x + rect.width)));
}

function useOverlayReserve(): number {
  const [reserve, setReserve] = useState(measureOverlayReserve);
  useEffect(() => {
    const update = () => setReserve(measureOverlayReserve());
    window.addEventListener('resize', update);
    windowControlsOverlay()?.addEventListener('geometrychange', update);
    const overlay = windowControlsOverlay();
    return () => {
      window.removeEventListener('resize', update);
      overlay?.removeEventListener('geometrychange', update);
    };
  }, []);
  return reserve;
}

const navButton =
  'min-w-[29px] min-h-[26px] rounded-md border border-[#39475a] bg-[#1a2330] hover:bg-[#2a394d] leading-none disabled:hover:bg-[#1a2330]';

export function TitleBar({
  windowWidth,
  paneVisible,
  paneX,
  paneWidth,
  tabs,
  activeId,
}: TitleBarProps) {
  const overlayReserve = useOverlayReserve();
  const drop = useTabDrop();
  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const dragRight = paneVisible ? paneX : windowWidth - overlayReserve;
  const paneSegmentWidth = paneVisible ? Math.max(0, paneWidth - overlayReserve) : 0;

  return (
    <header
      id="titleBar"
      className="shell-chrome app-drag absolute top-0 left-0 bg-[#101722]"
      style={{
        width: windowWidth,
        height: TITLE_BAR_HEIGHT,
      }}
    >
      <div
        className="absolute left-0 top-0 flex items-center justify-center text-[#7d8a99] text-[11px] font-semibold tracking-wide select-none"
        style={{ width: RAIL_WIDTH, height: '100%' }}
        title="Agent Workspace"
      >
        {/* the macOS traffic lights cover the left rail */}
        {!isMac && <AgMark size={20} />}
      </div>
      {/* drag space over the main column (extends to the overlay gap when the pane is hidden) */}
      <div
        className="absolute top-0 h-full"
        style={{ left: RAIL_WIDTH, width: Math.max(0, dragRight - RAIL_WIDTH) }}
      />
      <div
        className="pointer-events-none absolute top-0 h-full flex items-center justify-center [&>*]:pointer-events-auto"
        style={{ left: RAIL_WIDTH, width: Math.max(0, dragRight - RAIL_WIDTH) }}
      >
        <NotificationBanner />
      </div>
      {paneVisible && (
        <div
          className="app-no-drag absolute top-0 h-full flex items-stretch gap-1.5 pr-1.5"
          style={{ left: paneX, width: paneSegmentWidth }}
          {...drop.handlers}
        >
          <button
            id="backButton"
            type="button"
            aria-label="Back"
            className={navButton}
            disabled={!active?.canGoBack}
            onClick={() => window.agentworkspace.navigate('back')}
          >
            ←
          </button>
          <button
            id="forwardButton"
            type="button"
            aria-label="Forward"
            className={navButton}
            disabled={!active?.canGoForward}
            onClick={() => window.agentworkspace.navigate('forward')}
          >
            →
          </button>
          <button
            id="reloadButton"
            type="button"
            aria-label="Reload"
            className={navButton}
            disabled={!active}
            title="Reload (right-click: reload all tabs in this session)"
            onClick={() => window.agentworkspace.navigate('reload')}
            onContextMenu={(e) => {
              e.preventDefault();
              window.agentworkspace.openReloadMenu(e.clientX, e.clientY);
            }}
          >
            ↻
          </button>
          <TabStrip tabs={tabs} activeId={activeId} />
          {/* Outside the strip's scroll/sortable area, like #tabFavorites after it. */}
          <button
            id="tabNew"
            type="button"
            aria-label="New tab"
            title="New tab (Ctrl+T)"
            className={`app-no-drag shrink-0 self-center ${navButton}`}
            onClick={() =>
              window.agentworkspace.setAddressBar({ open: true, mode: 'new', source: 'button' })
            }
          >
            +
          </button>
          <button
            id="tabFavorites"
            type="button"
            aria-label="Chrome bookmarks"
            title="Chrome bookmarks"
            className={`app-no-drag shrink-0 self-center flex items-center justify-center ${navButton}`}
            onClick={(e) => {
              // The shell view sits at the window origin with a fixed zoom, so client
              // coordinates are window coordinates; the menu drops from the bottom-left.
              const rect = e.currentTarget.getBoundingClientRect();
              void window.agentworkspace.openFavoritesMenu(rect.left, rect.bottom);
            }}
          >
            <StarIcon />
          </button>
          <MarkBlankButton activeId={active ? active.id : null} />
          {drop.hint && (
            <div
              id="tabDropHint"
              role="status"
              data-state={drop.hint.state}
              className={`tabDropHint ${drop.hint.state} pointer-events-none absolute inset-0 flex items-center justify-center rounded-md text-[12px]`}
            >
              {drop.hint.state === 'drop' ? 'Drop to open in a new tab' : drop.hint.text}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
