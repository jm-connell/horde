import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ErrorBoundary from "../components/ErrorBoundary";
import HelpChatPanel from "../components/HelpChatPanel";
import type { HelpFrame } from "../components/helpChatLayout";
import { HELP_PANEL_STORAGE_KEY as PANEL_STORAGE_KEY } from "../components/helpChat";
import { getJson, setJson } from "../storage";
import { useAuth } from "./AuthContext";

interface HelpChatValue {
  /** False when this account may not use AI (the panel cannot open). */
  available: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Set by a page to say which part of it is showing (see `useHelpPageDetail`). */
  setDetail: (detail: PageDetail) => void;
  /** Drop `detail` unless another page has replaced it already. */
  clearDetail: (detail: PageDetail) => void;
}

interface HostValue {
  frame: HelpFrame | null;
  setFrame: (frame: HelpFrame) => void;
  pageDetail: () => PageDetail | null;
  /** True once the user opened it in this page load (not restored on reload). */
  openedHere: boolean;
}

/** A page's own note on what is showing, e.g. the selected Settings tab. */
export interface PageDetail {
  /** The page it belongs to, so a page on its way out is not reported. */
  pathname: string;
  text: string;
}

const Ctx = createContext<HelpChatValue | null>(null);
const HostCtx = createContext<HostValue | null>(null);

interface PanelState {
  open: boolean;
  frame: HelpFrame | null;
}

function isFrame(v: unknown): v is HelpFrame {
  if (!v || typeof v !== "object") return false;
  const f = v as Record<string, unknown>;
  return ["left", "top", "width", "height"].every(
    (k) => typeof f[k] === "number" && Number.isFinite(f[k])
  );
}

function isPanelState(v: unknown): v is PanelState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.open === "boolean" && (s.frame === null || isFrame(s.frame));
}

/**
 * Ask about Horde, available on every page: the footer opens it and it stays
 * open (same conversation, same spot) while the user moves around the app.
 */
export function HelpChatProvider({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const available = can("use_ai");
  const [state, setState] = useState<PanelState>(() =>
    getJson(
      PANEL_STORAGE_KEY,
      isPanelState,
      { open: false, frame: null },
      "session"
    )
  );
  useEffect(() => {
    setJson(PANEL_STORAGE_KEY, state, "session");
  }, [state]);

  const [openedHere, setOpenedHere] = useState(false);
  const setOpen = useCallback((open: boolean) => {
    if (open) setOpenedHere(true);
    setState((s) => ({ ...s, open }));
  }, []);
  const detail = useRef<PageDetail | null>(null);
  const setDetail = useCallback((next: PageDetail) => {
    detail.current = next;
  }, []);
  const clearDetail = useCallback((mine: PageDetail) => {
    if (detail.current === mine) detail.current = null;
  }, []);
  const setFrame = useCallback(
    (frame: HelpFrame) => setState((s) => ({ ...s, frame })),
    []
  );
  const value = useMemo(
    () => ({
      available,
      open: available && state.open,
      setOpen,
      setDetail,
      clearDetail,
    }),
    [available, state.open, setOpen, setDetail, clearDetail]
  );

  const host = useMemo(
    () => ({
      frame: state.frame,
      setFrame,
      pageDetail: () => detail.current,
      openedHere,
    }),
    [state.frame, setFrame, openedHere]
  );

  return (
    <Ctx.Provider value={value}>
      <HostCtx.Provider value={host}>{children}</HostCtx.Provider>
    </Ctx.Provider>
  );
}

/**
 * The panel itself, mounted by the app shell once setup is done (not over the
 * loading screen or the setup wizard). Its own error boundary keeps a bad
 * answer from taking down the page.
 */
export function HelpChatHost() {
  const { open, setOpen } = useHelpChat();
  const host = useContext(HostCtx);
  if (!open || !host) return null;
  return (
    <ErrorBoundary scope="help-chat">
      <HelpChatPanel
        frame={host.frame}
        onFrameChange={host.setFrame}
        pageDetail={host.pageDetail}
        focusOnOpen={host.openedHere}
        onClose={() => setOpen(false)}
      />
    </ErrorBoundary>
  );
}

export function useHelpChat(): HelpChatValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useHelpChat must be used within HelpChatProvider");
  return ctx;
}

/**
 * Tell Ask about Horde which part of the page is showing (a tab, a pane), so
 * questions sent from here carry it. Cleared when the page unmounts.
 */
export function useHelpPageDetail(pathname: string, text: string | null) {
  const { setDetail, clearDetail } = useHelpChat();
  useEffect(() => {
    if (!text) return;
    const mine = { pathname, text };
    setDetail(mine);
    return () => clearDetail(mine);
  }, [pathname, text, setDetail, clearDetail]);
}
