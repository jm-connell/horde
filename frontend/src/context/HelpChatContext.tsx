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
  type AskVideo,
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
  /** Open the panel on a new conversation about this video ("Chat" on Watch). */
  askVideo: (video: AskVideo) => void;
  /** Set by a page about one channel (see `useAskPageChannel`). */
  setPageChannel: (page: PageChannel | null) => void;
  /** Set by the watch page (see `useAskPageVideo`). */
  setPageVideo: (page: PageVideo | null) => void;
  /** The Recommended algorithm panel (shown only while that feed is). */
  algorithmOpen: boolean;
  setAlgorithmOpen: (open: boolean) => void;
  /** Called by the Recommended feed while it is on screen (see `useAlgorithmPanelHere`). */
  setAlgorithmHere: (here: boolean) => void;
}

/** The video the watch page shows: Ask answers from it when nothing is picked. */
export interface PageVideo {
  pathname: string;
  video: AskVideo;
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
  /** The latest "Ask <channel>" or "Chat" request; a new one starts a new conversation. */
  sourceRequest: SourceRequest | null;
  /** The channel the current page is about, if any. */
  pageChannel: PageChannel | null;
  /** The video the watch page shows, if any. */
  pageVideo: PageVideo | null;
  /** The request the panel has not acted on yet (null once it has). */
  pendingSourceRequest: () => SourceRequest | null;
  /** The panel acted on this request. */
  consumeSourceRequest: (seq: number) => void;
}

/**
 * A request to start a conversation about a channel or a video (one of the
 * two; `seq` tells repeats apart).
 */
export interface SourceRequest {
  channel?: AskScopeChannel;
  video?: AskVideo;
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
  const [sourceRequest, setSourceRequest] = useState<SourceRequest | null>(
    null
  );
  const [pageChannel, setPageChannel] = useState<PageChannel | null>(null);
  const [pageVideo, setPageVideo] = useState<PageVideo | null>(null);
  // Kept here, not in the panel: the panel mounts on open, after the request.
  const consumedSeq = useRef(0);
  const latestRequest = useRef<SourceRequest | null>(null);
  latestRequest.current = sourceRequest;
  const pendingSourceRequest = useCallback(() => {
    const req = latestRequest.current;
    return req && req.seq > consumedSeq.current ? req : null;
  }, []);
  const consumeSourceRequest = useCallback((seq: number) => {
    consumedSeq.current = Math.max(consumedSeq.current, seq);
  }, []);
  const askChannel = useCallback(
    (channel: AskScopeChannel) => {
      setSourceRequest((prev) => ({ channel, seq: (prev?.seq ?? 0) + 1 }));
      setOpen(true);
    },
    [setOpen]
  );
  const askVideo = useCallback(
    (video: AskVideo) => {
      setSourceRequest((prev) => ({ video, seq: (prev?.seq ?? 0) + 1 }));
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
      askVideo,
      setPageChannel,
      setPageVideo,
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
      askVideo,
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
      sourceRequest,
      pageChannel,
      pageVideo,
      pendingSourceRequest,
      consumeSourceRequest,
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
      sourceRequest,
      pageChannel,
      pageVideo,
      pendingSourceRequest,
      consumeSourceRequest,
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
            sourceRequest={host.sourceRequest}
            pageChannel={host.pageChannel}
            pageVideo={host.pageVideo}
            pendingSourceRequest={host.pendingSourceRequest}
            consumeSourceRequest={host.consumeSourceRequest}
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
 * Tell the chat which video the watch page shows. With nothing picked, a
 * question on this page goes to it unless it is about Horde or a channel.
 */
export function useAskPageVideo(pathname: string, video: AskVideo | null) {
  const { setPageVideo } = useHelpChat();
  const libraryId = video?.library_id ?? null;
  const youtubeId = video?.youtube_id ?? null;
  const url = video?.url ?? null;
  const title = video?.title ?? "";
  useEffect(() => {
    if (libraryId == null && !url) return;
    setPageVideo({
      pathname,
      video: { library_id: libraryId, youtube_id: youtubeId, url, title },
    });
    return () => setPageVideo(null);
  }, [pathname, libraryId, youtubeId, url, title, setPageVideo]);
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
