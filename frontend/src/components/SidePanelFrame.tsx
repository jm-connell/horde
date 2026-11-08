import {
  Fragment,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  usePlaybackActions,
  usePlaybackLayout,
} from "../context/PlaybackContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { EASE_FLUID } from "../motion";
import { useVisualViewport } from "../hooks/useVisualViewport";
import {
  clampHelpFrame,
  defaultHelpFrame,
  DOCK_MIN_W,
  dockMaxWidth,
  dockWidthFor,
  type HelpFrame,
  resizeFromTopLeft,
} from "./helpChatLayout";
import { HELP_PANEL_ID } from "./helpChat";
import { ChevronIcon, CloseIcon, CollapseIcon, ExpandIcon } from "./icons";
import { ActiveCtx, SlotCtx } from "./sidePanelContext";

/** One body the frame shows: Ask, or the Recommended settings. */
export interface PanelTab {
  id: string;
  /** The tab's label when more than one body is open. */
  label: string;
  content: ReactNode;
}

/**
 * Put a body's title, a control beside it and header buttons into the
 * frame's header. Each body renders one; only the showing body's lands there.
 * The addon also shows beside the tabs, and the header is its positioning
 * parent (a menu it opens can span the header with `absolute inset-x-*`).
 */
export function PanelHeader({
  title,
  addon,
  actions,
}: {
  title: ReactNode;
  addon?: ReactNode;
  actions?: ReactNode;
}) {
  const slots = useContext(SlotCtx);
  const active = useContext(ActiveCtx);
  if (!active) return null;
  return (
    <>
      {slots.title && createPortal(title, slots.title)}
      {slots.addon && addon && createPortal(addon, slots.addon)}
      {slots.actions && actions && createPortal(actions, slots.actions)}
    </>
  );
}

/** Where the fixed top nav ends, kept current while ``active``. */
function useNavBottom(active: boolean): number {
  const nav = () => document.querySelector<HTMLElement>('[data-horde="nav"]');
  const measure = () =>
    Math.max(0, Math.round(nav()?.getBoundingClientRect().bottom ?? 0));
  // Measured before the first paint, so the docked panel never shows under
  // the nav for a frame.
  const [bottom, setBottom] = useState(() => (active ? measure() : 0));
  useLayoutEffect(() => {
    if (!active) return;
    const el = nav();
    if (!el) return;
    const update = () => setBottom(measure());
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nav and measure read the DOM; only switching on matters
  }, [active]);
  return bottom;
}

const MORPH_MS = 250;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Docking or floating the panel: glide from where it was to where it lands
 * (its box, not a scale, so the text stays sharp). Under reduced motion it
 * just moves.
 */
function useDockMorph(
  panelRef: React.RefObject<HTMLElement | null>,
  docked: boolean
) {
  const lastRect = useRef<DOMRect | null>(null);
  const wasDocked = useRef(docked);
  // Every render: the last box must be current when the dock state flips.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const from = lastRect.current;
    const to = el.getBoundingClientRect();
    if (from && wasDocked.current !== docked && !reducedMotion()) {
      const box = (r: DOMRect) => ({
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
        right: "auto",
        bottom: "auto",
      });
      el.animate([box(from), box(to)], {
        duration: MORPH_MS,
        easing: EASE_FLUID,
      });
    }
    wasDocked.current = docked;
    lastRect.current = to;
  });
}

function useViewport() {
  const [size, setSize] = useState(() => ({
    vw: window.innerWidth,
    vh: window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setSize({ vw: window.innerWidth, vh: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}

interface Props {
  tabs: PanelTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  /** Close one body (the frame goes away with the last one). */
  onCloseTab: (id: string) => void;
  /** Where the user dragged or resized it to; null until they do. */
  frame: HelpFrame | null;
  onFrameChange: (frame: HelpFrame) => void;
  /** Docked as a full-height side panel the page makes room for (desktop). */
  docked: boolean;
  onDockedChange: (docked: boolean) => void;
  /** The docked width the user dragged it to (null: the default). */
  dockWidth: number | null;
  onDockWidthChange: (width: number) => void;
  /** Folded to its header bar at the bottom of the window (bodies stay mounted). */
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
}

/** Height of the minimized bar (the header row). */
const BAR_H = 52;
const BAR_W = 320;
const BAR_MARGIN = 16;

/** The minimized bar's spot: bottom-right, above the mini player when it is there. */
function barPlacement(
  vw: number,
  vh: number,
  mini: { top: number; left: number; right: number; bottom: number } | null
): React.CSSProperties {
  const width = Math.min(BAR_W, vw - 2 * BAR_MARGIN);
  const left = vw - width - BAR_MARGIN;
  let top = vh - BAR_H - BAR_MARGIN;
  if (
    mini &&
    mini.left < left + width &&
    mini.right > left &&
    mini.bottom > top &&
    mini.top < top + BAR_H
  )
    top = Math.max(BAR_MARGIN, mini.top - BAR_H - BAR_MARGIN / 2);
  return { left, top, width, height: BAR_H };
}

/**
 * The floating (or docked) side panel that holds Ask and the
 * Recommended settings. With both open it shows tabs instead of two panels
 * side by side; each body stays mounted while hidden, so a conversation or a
 * half-moved slider survives switching tabs.
 */
export default function SidePanelFrame({
  tabs,
  activeTab,
  onTabChange,
  onCloseTab,
  frame,
  onFrameChange,
  docked,
  onDockedChange,
  dockWidth: wantedDockWidth,
  onDockWidthChange,
  minimized,
  onMinimizedChange,
}: Props) {
  const titleId = useId();
  const tabIdBase = useId();
  const panelRef = useRef<HTMLElement>(null);
  const [titleEl, setTitleEl] = useState<HTMLElement | null>(null);
  const [addonEl, setAddonEl] = useState<HTMLElement | null>(null);
  const [actionsEl, setActionsEl] = useState<HTMLElement | null>(null);
  const { miniPlayerRect } = usePlaybackLayout();
  const isMobile = useIsMobile();
  const viewport = useVisualViewport(isMobile);
  const { vw, vh } = useViewport();
  const tabbed = tabs.length > 1;
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const isChat = active.id === "ask";
  const noun = tabbed ? "panel" : isChat ? "chat" : "panel";
  // Docked: a column on the right below the full-width nav; the page makes room
  // through --horde-chat-dock (index.css). Phones keep the bottom sheet.
  // Minimized, a docked panel gives the page its width back until restored.
  const dockedHere = docked && !isMobile && !minimized;
  const floating = !isMobile && !dockedHere && !minimized;
  const dockWidth = dockWidthFor(wantedDockWidth, vw);
  const navBottom = useNavBottom(dockedHere);
  useDockMorph(panelRef, dockedHere);
  const { setChatDocked } = usePlaybackActions();
  const floatRef = useRef(() => onDockedChange(false));
  floatRef.current = () => onDockedChange(false);
  useEffect(() => {
    if (!dockedHere) return;
    // The player's Theater button floats the panel to leave theater.
    setChatDocked(() => floatRef.current());
    const root = document.documentElement;
    root.dataset.chatDocked = "true";
    root.style.setProperty("--horde-chat-dock", `${dockWidth}px`);
    return () => {
      setChatDocked(null);
      delete root.dataset.chatDocked;
      root.style.removeProperty("--horde-chat-dock");
    };
  }, [dockedHere, dockWidth, setChatDocked]);
  const box = frame
    ? clampHelpFrame(frame, vw, vh)
    : defaultHelpFrame(vw, vh, miniPlayerRect);

  // A layout effect, so its cleanup still sees the panel (and where focus
  // is) before React removes it.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    const panel = panelRef.current;
    return () => {
      // Only when closing from inside: the user may have moved on since.
      const inside = !!panel?.contains(document.activeElement);
      if (inside && opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, []);

  // Escape closes the showing body while focus is inside (it is not modal).
  const closeRef = useRef(() => onCloseTab(active.id));
  closeRef.current = () => onCloseTab(active.id);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // An open menu or list inside the panel closes first (ThemedSelect).
      const target = e.target as HTMLElement | null;
      if (
        e.defaultPrevented ||
        target?.closest('[aria-expanded="true"], [role="listbox"]')
      )
        return;
      e.stopPropagation();
      closeRef.current();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  // Window listeners of a drag in flight, so unmounting mid-drag drops them.
  const dragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => dragCleanup.current?.(), []);

  function startDrag(
    e: React.PointerEvent<HTMLElement>,
    apply: (dx: number, dy: number) => HelpFrame
  ) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const { clientX: x0, clientY: y0, pointerId } = e;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      onFrameChange(apply(ev.clientX - x0, ev.clientY - y0));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      dragCleanup.current = null;
    };
    dragCleanup.current?.();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    dragCleanup.current = stop;
  }

  function onHeaderPointerDown(e: React.PointerEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest("button, a, [role=tab], [role=menu]"))
      return;
    const start = box;
    startDrag(e, (dx, dy) =>
      clampHelpFrame(
        { ...start, left: start.left + dx, top: start.top + dy },
        window.innerWidth,
        window.innerHeight
      )
    );
  }

  /** Drag the docked panel's left edge: wider to the left, narrower to the right. */
  function onDockResizePointerDown(e: React.PointerEvent<HTMLElement>) {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    e.preventDefault();
    const { clientX: x0, pointerId } = e;
    const start = dockWidth;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      onDockWidthChange(
        dockWidthFor(start - (ev.clientX - x0), window.innerWidth)
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      document.body.style.removeProperty("cursor");
      dragCleanup.current = null;
    };
    dragCleanup.current?.();
    document.body.style.cursor = "ew-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    dragCleanup.current = stop;
  }

  function onDockResizeKey(e: React.KeyboardEvent<HTMLElement>) {
    const step = e.shiftKey ? 64 : 16;
    const next =
      e.key === "ArrowLeft"
        ? dockWidth + step
        : e.key === "ArrowRight"
          ? dockWidth - step
          : e.key === "Home"
            ? dockWidthFor(null, window.innerWidth)
            : null;
    if (next == null) return;
    e.preventDefault();
    onDockWidthChange(dockWidthFor(next, window.innerWidth));
  }

  function onResizePointerDown(e: React.PointerEvent<HTMLElement>) {
    const start = box;
    startDrag(e, (dx, dy) =>
      resizeFromTopLeft(start, dx, dy, window.innerWidth, window.innerHeight)
    );
  }

  function onTabKey(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === active.id);
    const next =
      tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    onTabChange(next.id);
    document.getElementById(`${tabIdBase}-${next.id}`)?.focus();
  }

  // With the keyboard up, sit just above it inside what is visible: pinned
  // to the bottom, iOS pans the page and the panel's top goes off screen.
  const keyboardHeight = `min(36rem, 75dvh, ${viewport?.height ?? 0}px - 1rem)`;
  const placement: React.CSSProperties | undefined = minimized
    ? isMobile
      ? { height: BAR_H }
      : barPlacement(vw, vh, miniPlayerRect)
    : dockedHere
      ? { top: navBottom, right: 0, bottom: 0, width: dockWidth }
      : isMobile
        ? viewport?.keyboard
          ? {
              top: `calc(${viewport.top + viewport.height}px - ${keyboardHeight} - 0.5rem)`,
              bottom: "auto",
              height: keyboardHeight,
            }
          : undefined
        : {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
          };

  return createPortal(
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={tabbed ? `${tabIdBase}-${active.id}` : titleId}
      id={HELP_PANEL_ID}
      data-horde={
        isChat || tabs.some((t) => t.id === "ask") ? "help-chat" : "side-panel"
      }
      data-panel-tab={active.id}
      ref={panelRef}
      style={placement}
      data-docked={dockedHere ? "true" : undefined}
      data-minimized={minimized ? "true" : undefined}
      className={`ui-panel ui-panel-legible fixed z-45 flex flex-col overflow-hidden bg-ink-900 ${
        dockedHere
          ? "border-l border-ink-700"
          : "rounded-xl shadow-2xl ring-1 ring-ink-600"
      } ${
        isMobile
          ? `inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom),var(--horde-bottom-bar,0px))] ${
              minimized ? "" : "h-[min(36rem,75dvh)]"
            }`
          : ""
      }`}
    >
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- a focusable separator is the ARIA window-splitter pattern (as in ResizeHandle); it takes pointer and arrow-key input */}
      {dockedHere && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize the ${noun}`}
          aria-valuenow={dockWidth}
          aria-valuemin={DOCK_MIN_W}
          aria-valuemax={dockMaxWidth(vw)}
          tabIndex={0}
          title="Drag to resize"
          data-horde="help-chat-resize"
          onPointerDown={onDockResizePointerDown}
          onKeyDown={onDockResizeKey}
          className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize touch-none transition-colors hover:bg-accent/30 focus-visible:bg-accent/50 focus-visible:outline-hidden"
        />
      )}
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      {floating && (
        <div
          className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
          title="Drag to resize"
          aria-hidden="true"
          onPointerDown={onResizePointerDown}
        />
      )}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- a click on the minimized bar is a shortcut; the Restore button is the keyboard path */}
      <header
        className={`relative flex items-center justify-between gap-2 px-4 py-2.5 ${
          minimized ? "h-full cursor-pointer" : "border-b border-ink-700"
        } ${floating ? "cursor-move touch-none select-none" : ""}`}
        onPointerDown={floating ? onHeaderPointerDown : undefined}
        onClick={
          minimized
            ? (e) => {
                if (!(e.target as HTMLElement).closest("button, a, [role=tab]"))
                  onMinimizedChange(false);
              }
            : undefined
        }
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {tabbed ? (
            // `contents`, so the tabs are this row's items and the showing
            // body's addon can sit right after its own tab ("Ask Horde ▾ |
            // Algorithm") by `order`, without a non-tab inside the tablist.
            <div role="tablist" aria-label="Side panel" className="contents">
              {tabs.map((t, i) => {
                const selected = t.id === active.id;
                return (
                  <Fragment key={t.id}>
                    {i > 0 && (
                      <span
                        aria-hidden="true"
                        style={{ order: 3 * i - 1 }}
                        className="h-4 w-px shrink-0 bg-ink-700"
                      />
                    )}
                    <button
                      type="button"
                      role="tab"
                      id={`${tabIdBase}-${t.id}`}
                      aria-selected={selected}
                      aria-controls={`${tabIdBase}-${t.id}-panel`}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => onTabChange(t.id)}
                      onKeyDown={onTabKey}
                      style={{ order: 3 * i }}
                      className={`-my-1 shrink-0 whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                        selected
                          ? "bg-ink-800 text-gray-100"
                          : "text-muted hover:text-accent"
                      }`}
                    >
                      {t.label}
                    </button>
                  </Fragment>
                );
              })}
            </div>
          ) : (
            <h2
              id={titleId}
              className="min-w-0 truncate text-sm font-semibold text-gray-100"
            >
              {/* The showing body puts its title here (PanelHeader). */}
              <span ref={setTitleEl} />
            </h2>
          )}
          {/* ... and a control beside it, such as Ask's source. */}
          <span
            ref={setAddonEl}
            style={
              tabbed
                ? { order: 3 * tabs.findIndex((t) => t.id === active.id) + 1 }
                : undefined
            }
            className="flex min-w-0"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div
            ref={setActionsEl}
            className={minimized ? "hidden" : "flex items-center gap-1"}
          />
          <button
            type="button"
            onClick={() => onMinimizedChange(!minimized)}
            aria-expanded={!minimized}
            aria-label={
              minimized ? `Restore the ${noun}` : `Minimize the ${noun}`
            }
            title={minimized ? "Restore" : "Minimize"}
            data-horde="side-panel-minimize"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-accent"
          >
            <ChevronIcon
              className={`h-4 w-4 transition-transform duration-200 ease-fluid ${
                minimized ? "rotate-180" : ""
              }`}
            />
          </button>
          {!isMobile && !minimized && (
            <button
              type="button"
              onClick={() => onDockedChange(!docked)}
              aria-pressed={docked}
              aria-label={
                docked ? `Float the ${noun}` : `Dock the ${noun} at the side`
              }
              title={docked ? "Float" : "Dock at the side"}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-accent"
            >
              {docked ? (
                <CollapseIcon className="h-4 w-4" />
              ) : (
                <ExpandIcon className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={() => onCloseTab(active.id)}
            aria-label={tabbed ? `Close ${active.label}` : "Close"}
            title="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-accent"
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      <SlotCtx.Provider
        value={{
          title: tabbed ? null : titleEl,
          addon: addonEl,
          actions: actionsEl,
          isMobile,
        }}
      >
        {tabs.map((t) => {
          const showing = t.id === active.id;
          return (
            <div
              key={t.id}
              id={`${tabIdBase}-${t.id}-panel`}
              role={tabbed ? "tabpanel" : undefined}
              aria-labelledby={tabbed ? `${tabIdBase}-${t.id}` : undefined}
              hidden={!showing || minimized}
              // The hidden attribute alone loses to a display class.
              // Switching tabs fades the body in (from display: none).
              className={
                showing && !minimized
                  ? "flex min-h-0 flex-1 flex-col transition-opacity duration-150 ease-fluid starting:opacity-0"
                  : "hidden"
              }
            >
              <ActiveCtx.Provider value={showing}>
                {t.content}
              </ActiveCtx.Provider>
            </div>
          );
        })}
      </SlotCtx.Provider>
    </section>,
    document.body
  );
}
