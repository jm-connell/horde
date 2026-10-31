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
import {
  type AskScopeChannel,
  HELP_PANEL_STORAGE_KEY as PANEL_STORAGE_KEY,
} from "../components/helpChat";
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
  /** Open the panel on a new conversation about this Ask channel. */
  askChannel: (channel: AskScopeChannel) => void;
}

interface HostValue {
  frame: HelpFrame | null;
  setFrame: (frame: HelpFrame) => void;
  docked: boolean;
  setDocked: (docked: boolean) => void;
  pageDetail: () => PageDetail | null;
  /** True once the user opened it in this page load (not restored on reload). */
  openedHere: boolean;
  /** The latest "Ask <channel>" request; a new one starts a new conversation. */
  channelRequest: ChannelRequest | null;
  /** The request the panel has not acted on yet (null once it has). */
  pendingChannelRequest: () => ChannelRequest | null;
  /** The panel acted on this request. */
  consumeChannelRequest: (seq: number) => void;
}

/** A request to start a conversation about a channel (`seq` tells repeats apart). */
export interface ChannelRequest {
  channel: AskScopeChannel;
  seq: number;
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
  /** Docked as a full-height side panel the page makes room for (desktop). */
  docked?: boolean;
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
  return (
    typeof s.open === "boolean" &&
    (s.frame === null || isFrame(s.frame)) &&
    (s.docked === undefined || typeof s.docked === "boolean")
  );
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
  const [channelRequest, setChannelRequest] = useState<ChannelRequest | null>(
    null
  );
  // Kept here, not in the panel: the panel mounts on open, after the request.
  const consumedSeq = useRef(0);
  const latestRequest = useRef<ChannelRequest | null>(null);
  latestRequest.current = channelRequest;
  const pendingChannelRequest = useCallback(() => {
    const req = latestRequest.current;
    return req && req.seq > consumedSeq.current ? req : null;
  }, []);
  const consumeChannelRequest = useCallback((seq: number) => {
    consumedSeq.current = Math.max(consumedSeq.current, seq);
  }, []);
  const askChannel = useCallback(
    (channel: AskScopeChannel) => {
      setChannelRequest((prev) => ({ channel, seq: (prev?.seq ?? 0) + 1 }));
      setOpen(true);
    },
    [setOpen]
  );
  const setFrame = useCallback(
    (frame: HelpFrame) => setState((s) => ({ ...s, frame })),
    []
  );
  const setDocked = useCallback(
    (docked: boolean) => setState((s) => ({ ...s, docked })),
    []
  );
  const value = useMemo(
    () => ({
      available,
      open: available && state.open,
      setOpen,
      setDetail,
      clearDetail,
      askChannel,
    }),
    [available, state.open, setOpen, setDetail, clearDetail, askChannel]
  );

  const host = useMemo(
    () => ({
      frame: state.frame,
      setFrame,
      docked: !!state.docked,
      setDocked,
      pageDetail: () => detail.current,
      openedHere,
      channelRequest,
      pendingChannelRequest,
      consumeChannelRequest,
    }),
    [
      state.frame,
      setFrame,
      state.docked,
      setDocked,
      openedHere,
      channelRequest,
      pendingChannelRequest,
      consumeChannelRequest,
    ]
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
        docked={host.docked}
        onDockedChange={host.setDocked}
        onFrameChange={host.setFrame}
        pageDetail={host.pageDetail}
        focusOnOpen={host.openedHere}
        channelRequest={host.channelRequest}
        pendingChannelRequest={host.pendingChannelRequest}
        consumeChannelRequest={host.consumeChannelRequest}
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
