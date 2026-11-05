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
import TuningPanel from "../components/discover/TuningPanel";
import HelpChatPanel from "../components/HelpChatPanel";
import SidePanelFrame, { type PanelTab } from "../components/SidePanelFrame";
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
  /** Set by a page about one channel (see `useAskPageChannel`). */
  setPageChannel: (page: PageChannel | null) => void;
  /** The Recommended algorithm panel (shown only while that feed is). */
  algorithmOpen: boolean;
  setAlgorithmOpen: (open: boolean) => void;
  /** Called by the Recommended feed while it is on screen (see `useAlgorithmPanelHere`). */
  setAlgorithmHere: (here: boolean) => void;
}

/** The channel (and video) a page is about, for routing Ask questions. */
export interface PageChannel {
  pathname: string;
  channelUrl: string | null;
  channelName: string | null;
  /** The YouTube id of the video being watched. */
  videoId: string | null;
}

interface HostValue {
  tab: PanelTabId;
  setTab: (tab: PanelTabId) => void;
  /** The algorithm panel is open and the Recommended feed is on screen. */
  algorithmShown: boolean;
  frame: HelpFrame | null;
  setFrame: (frame: HelpFrame) => void;
  docked: boolean;
  setDocked: (docked: boolean) => void;
  dockWidth: number | null;
  setDockWidth: (width: number) => void;
  pageDetail: () => PageDetail | null;
  /** True once the user opened it in this page load (not restored on reload). */
  openedHere: boolean;
  /** The latest "Ask <channel>" request; a new one starts a new conversation. */
  channelRequest: ChannelRequest | null;
  /** The channel the current page is about, if any. */
  pageChannel: PageChannel | null;
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

type PanelTabId = "ask" | "algorithm";

interface PanelState {
  open: boolean;
  /** The Recommended algorithm panel is open (it shares the frame). */
  algorithm?: boolean;
  /** Which body shows when both are open. */
  tab?: PanelTabId;
  frame: HelpFrame | null;
  /** Docked as a full-height side panel the page makes room for (desktop). */
  docked?: boolean;
  /** The docked panel's width, once the user has dragged it. */
  dockWidth?: number | null;
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
    (s.algorithm === undefined || typeof s.algorithm === "boolean") &&
    (s.tab === undefined || s.tab === "ask" || s.tab === "algorithm") &&
    (s.frame === null || isFrame(s.frame)) &&
    (s.docked === undefined || typeof s.docked === "boolean") &&
    (s.dockWidth == null ||
      (typeof s.dockWidth === "number" && Number.isFinite(s.dockWidth)))
  );
}

/**
 * Ask, available on every page: the footer opens it and it stays
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
    setState((s) => ({
      ...s,
      open,
      tab: open ? "ask" : s.algorithm ? "algorithm" : s.tab,
    }));
  }, []);
  const setAlgorithmOpen = useCallback((algorithm: boolean) => {
    setState((s) => ({
      ...s,
      algorithm,
      tab: algorithm ? "algorithm" : s.open ? "ask" : s.tab,
    }));
  }, []);
  const setTab = useCallback(
    (tab: PanelTabId) => setState((s) => ({ ...s, tab })),
    []
  );
  const [algorithmHere, setAlgorithmHere] = useState(false);
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
  const [pageChannel, setPageChannel] = useState<PageChannel | null>(null);
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
  const setDockWidth = useCallback(
    (dockWidth: number) => setState((s) => ({ ...s, dockWidth })),
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
      setPageChannel,
      algorithmOpen: !!state.algorithm,
      setAlgorithmOpen,
      setAlgorithmHere,
    }),
    [
      available,
      state.open,
      setOpen,
      setDetail,
      clearDetail,
      askChannel,
      state.algorithm,
      setAlgorithmOpen,
    ]
  );

  const host = useMemo(
    () => ({
      tab: state.tab ?? "ask",
      setTab,
      algorithmShown: !!state.algorithm && algorithmHere,
      frame: state.frame,
      setFrame,
      docked: !!state.docked,
      setDocked,
      dockWidth: state.dockWidth ?? null,
      setDockWidth,
      pageDetail: () => detail.current,
      openedHere,
      channelRequest,
      pageChannel,
      pendingChannelRequest,
      consumeChannelRequest,
    }),
    [
      state.tab,
      setTab,
      state.algorithm,
      algorithmHere,
      state.frame,
      setFrame,
      state.docked,
      setDocked,
      state.dockWidth,
      setDockWidth,
      openedHere,
      channelRequest,
      pageChannel,
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
 * The side panel, mounted by the app shell once setup is done (not over the
 * loading screen or the setup wizard): Ask, the Recommended
 * algorithm, or both as tabs. Each body has its own error boundary, so a bad
 * answer cannot take down the page (or the other body).
 */
export function HelpChatHost() {
  const { open, setOpen, setAlgorithmOpen } = useHelpChat();
  const host = useContext(HostCtx);
  if (!host) return null;
  const tabs: PanelTab[] = [];
  if (open) {
    tabs.push({
      id: "ask",
      label: "Ask",
      content: (
        <ErrorBoundary scope="help-chat">
          <HelpChatPanel
            pageDetail={host.pageDetail}
            focusOnOpen={host.openedHere}
            channelRequest={host.channelRequest}
            pageChannel={host.pageChannel}
            pendingChannelRequest={host.pendingChannelRequest}
            consumeChannelRequest={host.consumeChannelRequest}
            onClose={() => setOpen(false)}
          />
        </ErrorBoundary>
      ),
    });
  }
  if (host.algorithmShown) {
    tabs.push({
      id: "algorithm",
      label: "Algorithm",
      content: (
        <ErrorBoundary scope="algorithm-panel">
          <TuningPanel />
        </ErrorBoundary>
      ),
    });
  }
  if (!tabs.length) return null;
  return (
    <SidePanelFrame
      tabs={tabs}
      activeTab={host.tab}
      onTabChange={(id) =>
        host.setTab(id === "algorithm" ? "algorithm" : "ask")
      }
      onCloseTab={(id) =>
        id === "algorithm" ? setAlgorithmOpen(false) : setOpen(false)
      }
      frame={host.frame}
      onFrameChange={host.setFrame}
      docked={host.docked}
      onDockedChange={host.setDocked}
      dockWidth={host.dockWidth}
      onDockWidthChange={host.setDockWidth}
    />
  );
}

export function useHelpChat(): HelpChatValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useHelpChat must be used within HelpChatProvider");
  return ctx;
}

/**
 * Tell Ask which part of the page is showing (a tab, a pane), so
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

/**
 * Tell the chat which channel (and video) this page is about. A question that
 * names no channel and is not about Horde is then answered from it.
 */
export function useAskPageChannel(
  pathname: string,
  channelUrl: string | null | undefined,
  channelName: string | null | undefined,
  videoId: string | null = null
) {
  const { setPageChannel } = useHelpChat();
  useEffect(() => {
    if (!channelUrl && !channelName) return;
    setPageChannel({
      pathname,
      channelUrl: channelUrl ?? null,
      channelName: channelName ?? null,
      videoId,
    });
    return () => setPageChannel(null);
  }, [pathname, channelUrl, channelName, videoId, setPageChannel]);
}

/**
 * The Recommended feed is on screen: the algorithm panel may show (it hides,
 * but stays open, while the user is elsewhere).
 */
export function useAlgorithmPanelHere() {
  const { setAlgorithmHere } = useHelpChat();
  useEffect(() => {
    setAlgorithmHere(true);
    return () => setAlgorithmHere(false);
  }, [setAlgorithmHere]);
}
