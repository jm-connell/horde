import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { useAuth } from "../context/AuthContext";
import { usePlaybackSession } from "../context/PlaybackContext";
import type {
  PageChannel,
  PageDetail,
  PageVideo,
  SourceRequest,
} from "../context/HelpChatContext";
import { extractYouTubeId } from "../hooks/useSponsorBlock";
import { findAskChannel } from "../pages/ask/askLinks";
import type { HelpCatalog } from "../types";
import { useSettings } from "../hooks/useSettings";
import { appSettingsQuery } from "../queries/app";
import { queryKeys } from "../queries/keys";
import { getJson, removeItem, setJson } from "../storage";
import AiMarkdown, { type InlineRenderers } from "./AiMarkdown";
import { AskCite, AskReferenceList } from "./AskReferences";
import { markdownHref } from "./aiMarkdownParse";
import {
  CssPreviewCard,
  HelpActionCards,
  HelpTokenLink,
} from "./HelpChatActions";
import {
  ASK_CHAT_STORAGE_KEY,
  type AskChatState,
  type AskReference,
  type AskScopeChannel,
  type AskSourceState,
  type AskVideo,
  askVideoKey,
  HELP_CHAT_STORAGE_KEY,
  type HelpMessage,
  isAskState,
  isHelpThread,
  isPromptHistory,
  parseAskVideo,
  parseReferences,
  parseScopeChannels,
  parseSources,
  rememberPrompt,
  savedSources,
  stepPromptHistory,
} from "./helpChat";
import { describePage } from "./helpPage";
import {
  capabilitiesAnswer,
  pickPrompts,
  promptAllowed,
  WHAT_CAN_YOU_DO,
} from "./helpPrompts";
import { cssBlocks, splitActions } from "./helpTokens";
import { CloseIcon } from "./icons";
import { PanelHeader } from "./SidePanelFrame";
import { usePanelFrame } from "./sidePanelContext";
import TypingDots from "./TypingDots";

/** The site a link leaves Horde for, or null when it stays on this server. */
function offSiteHost(href: string): string | null {
  try {
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin ? null : url.host;
  } catch {
    return null;
  }
}

/** Paths the app's router serves (the wiki and the API are not among them). */
function isAppPath(href: string): boolean {
  return /^\/(?![/\\])/.test(href) && !/^\/(wiki|api)(\/|$)/.test(href);
}

/** Nothing picked: each question goes to Horde or a channel, by what it asks. */
const AUTO: AskSourceState = { scope: [], video: null };

/** "Ask … instead" under a reply: the same question, answered from here. */
type Instead =
  | { kind: "horde" }
  | { kind: "video"; video: AskVideo }
  | { kind: "channel"; channel: AskScopeChannel };

/** The source a request starts a conversation on. */
function requestedSource(req: SourceRequest): AskSourceState {
  return req.video
    ? { scope: [], video: req.video }
    : { scope: req.channel ? [req.channel] : [], video: null };
}

/** "Chat" on the video the conversation is already about carries it on. */
function resumes(req: SourceRequest | null, state: AskChatState): boolean {
  return (
    !!req?.video &&
    !!state.video &&
    askVideoKey(req.video) === askVideoKey(state.video)
  );
}

/** A library video or a stream as Ask refers to it. */
function playingVideo(
  current: { id: number; title: string; source_url?: string | null } | null,
  stream: { url: string; title: string; sourceUrl?: string | null } | null
): AskVideo | null {
  if (current)
    return {
      library_id: current.id,
      youtube_id: extractYouTubeId(current.source_url ?? "", "") || null,
      url: null,
      title: current.title,
    };
  if (stream)
    return {
      library_id: null,
      youtube_id: extractYouTubeId(stream.sourceUrl || stream.url, "") || null,
      url: stream.url,
      title: stream.title,
    };
  return null;
}

/** Who an answer is from: the video or the channels it quotes, else Horde. */
function answeredFrom(m: HelpMessage): string {
  if (m.video) return m.video.title || "This video";
  if (!m.references) return "Horde";
  const names = (m.channels ?? []).map((c) => c.name).filter(Boolean);
  return names.length ? names.join(", ") : "Channels";
}

function isWhatCanYouDo(text: string): boolean {
  const plain = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .trim();
  return plain(text) === plain(WHAT_CAN_YOU_DO);
}

interface Props {
  /** The current page's note on what is showing (e.g. the Settings tab). */
  pageDetail: () => PageDetail | null;
  /** Focus the question box (false when restored open after a reload). */
  focusOnOpen: boolean;
  /** "Ask <channel>" or the watch page's "Chat": a new conversation about it. */
  sourceRequest?: SourceRequest | null;
  /** The channel (and video) the current page is about. */
  pageChannel?: PageChannel | null;
  /** The video the watch page shows. */
  pageVideo?: PageVideo | null;
  pendingSourceRequest?: () => SourceRequest | null;
  consumeSourceRequest?: (seq: number) => void;
  onClose: () => void;
}

/** Starters when the chat is about a video. */
const VIDEO_PROMPTS = [
  "What is this video about?",
  "What are the key points?",
  "What did viewers think?",
];

const BUTTON =
  "ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * One reply: its text with links in place, then (once it has finished
 * streaming) a card for each action it offers and each CSS block.
 */
function AssistantReply({
  content,
  streaming,
  renderers,
  catalog,
  references,
  untrusted,
  autoApply,
  onNavigate,
}: {
  content: string;
  streaming: boolean;
  /** A reply that just arrived: apply its personal settings at once. */
  autoApply: boolean;
  renderers: InlineRenderers;
  catalog: HelpCatalog | undefined;
  /** Ask channel answers: markers become links to these. */
  references?: AskReference[];
  /** Built from text anyone could have written (captions, comments). */
  untrusted: boolean;
  onNavigate: () => void;
}) {
  const { text, actions } = splitActions(content);
  const byN = new Map((references ?? []).map((r) => [r.n, r]));
  // A channel or video answer is built from captions, descriptions and
  // comments anyone could have written, so its help tokens stay text and it
  // offers no actions or CSS.
  const render: InlineRenderers = untrusted
    ? {
        link: renderers.link,
        token: (raw) => raw,
        // While streaming, the numbers are the model's excerpt numbers: hidden
        // until the server sends the renumbered answer with its references.
        cite: (n, key) => {
          const ref = byN.get(n);
          if (ref)
            return (
              <AskCite key={key} reference={ref} onNavigate={onNavigate} />
            );
          return streaming ? null : `[${n}]`;
        },
      }
    : renderers;
  return (
    <>
      <AiMarkdown
        text={text}
        render={render}
        className="space-y-2 text-sm text-gray-300"
      />
      {!streaming && references && (
        <AskReferenceList references={references} onNavigate={onNavigate} />
      )}
      {!streaming && !untrusted && (
        <>
          <HelpActionCards
            actions={actions}
            catalog={catalog}
            autoApply={autoApply}
            onNavigate={onNavigate}
          />
          {cssBlocks(content).map((css) => (
            <div key={css} className="mt-2">
              <CssPreviewCard css={css} />
            </div>
          ))}
        </>
      )}
    </>
  );
}

/**
 * Ask: a chat in the corner that answers from Horde (this server's docs and
 * source, its settings, the user's library) or from channels Ask indexes; the
 * source shows beside the title ("Ask Northwind"), where the user can pick
 * another. It
 * floats over every page (drag it by its header, resize it from the top-left
 * corner) and tells the server which page the user is on. The conversation
 * lives in this tab (sessionStorage) and on the server.
 */
export default function HelpChatPanel({
  pageDetail,
  focusOnOpen,
  sourceRequest = null,
  pageChannel = null,
  pageVideo = null,
  pendingSourceRequest = () => null,
  consumeSourceRequest = () => {},
  onClose,
}: Props) {
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Opened by "Ask <channel>" or "Chat": start on a new conversation about
  // it. (The panel mounts on open, so the request is already there; peeking,
  // not taking, keeps React's doubled initialisers harmless.)
  const [opening] = useState(() => pendingSourceRequest());
  // The saved conversation this tab shows, where it is answered from, and
  // the source last picked (kept with it, so a reopened panel has it too).
  const [saved] = useState(() =>
    getJson(
      ASK_CHAT_STORAGE_KEY,
      isAskState,
      { threadId: null, scope: [] },
      "session"
    )
  );
  const [fresh] = useState(() => !!opening && !resumes(opening, saved));
  const [messages, setMessages] = useState<HelpMessage[]>(() =>
    fresh ? [] : getJson(HELP_CHAT_STORAGE_KEY, isHelpThread, [], "session")
  );
  const [ask, setAsk] = useState<AskChatState>(() => {
    if (!fresh || !opening) return saved;
    const source = requestedSource(opening);
    return { threadId: null, ...source, picked: source };
  });
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAdmin, can, user } = useAuth();
  // Questions sent before (this account, this device) for the Up / Down keys.
  const promptKey = `horde.help.prompts.${user?.id ?? "anon"}`;
  const promptHistory = useRef<string[] | null>(null);
  promptHistory.current ??= getJson(promptKey, isPromptHistory, []);
  /** The history entry shown in the box, or null while typing a new one. */
  const promptPos = useRef<number | null>(null);
  /** What was being typed before stepping into the history. */
  const promptStash = useRef("");
  /** Replies that arrived while the panel was open (not restored ones):
   *  their simple personal settings apply by themselves. */
  const liveReplies = useRef(new Set<string>());
  const [settings] = useSettings();
  // A new set each time the panel opens (it mounts on open).
  const [prompts] = useState(() =>
    pickPrompts((p) => promptAllowed(p, { isAdmin, can }))
  );
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: queryKeys.ai.helpCatalog,
    queryFn: ({ signal }) => api.getHelpCatalog({ signal }),
    staleTime: Infinity,
  }).data;
  const info = useQuery({
    queryKey: queryKeys.ai.helpInfo,
    queryFn: ({ signal }) => api.getHelpInfo({ signal }),
    // Read again on each opening: the provider (local or cloud) may change.
    staleTime: 0,
    enabled: can("use_ai"),
  }).data;
  // No provider (or no AI permission): answers are searches of the docs.
  const noAi = info?.available === false || !can("use_ai");
  // Settings → Library; the server holds the data back from a cloud AI when
  // only "local" was allowed.
  const consent = settings.helpChatData;

  const location = useLocation();
  const { current, stream, miniPlayerActive } = usePlaybackSession();
  const { isMobile } = usePanelFrame();

  const autoFocusRef = useRef(focusOnOpen);
  useEffect(() => {
    if (autoFocusRef.current) inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);
  useEffect(() => {
    // Only finished turns: a half-streamed reply is not worth restoring.
    if (!sending) setJson(HELP_CHAT_STORAGE_KEY, messages, "session");
  }, [messages, sending]);
  useEffect(() => {
    setJson(ASK_CHAT_STORAGE_KEY, ask, "session");
  }, [ask]);

  // "Ask <channel>" or "Chat" while the panel is open: a new conversation.
  useEffect(() => {
    const req = pendingSourceRequest();
    if (!req) return;
    consumeSourceRequest(req.seq);
    if (req.seq === opening?.seq) return; // started on it already
    if (resumes(req, ask)) {
      inputRef.current?.focus();
      return;
    }
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setShowHistory(false);
    const source = requestedSource(req);
    setAsk({ threadId: null, ...source, picked: source });
    inputRef.current?.focus();
  }, [sourceRequest, pendingSourceRequest, consumeSourceRequest, opening, ask]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  function currentPage(): string {
    const detail = pageDetail();
    return describePage(location.pathname, location.search, {
      detail: detail?.pathname === location.pathname ? detail.text : undefined,
      miniPlayer: miniPlayerActive && !!(current || stream),
    });
  }

  async function send(question: string, instead?: Instead) {
    const text = question.trim();
    if (!text || sending) return;
    setDraft("");
    setError(null);
    promptHistory.current = rememberPrompt(promptHistory.current ?? [], text);
    setJson(promptKey, promptHistory.current);
    promptPos.current = null;
    if (isWhatCanYouDo(text)) {
      // Answered here: it is about this app, not something to look up.
      const stamp = Date.now();
      setMessages((prev) => [
        ...prev,
        { id: `user-${stamp}`, role: "user", content: text },
        {
          id: `reply-${stamp}`,
          role: "assistant",
          content: capabilitiesAnswer({
            info,
            isAdmin,
            canDownload: can("download"),
          }),
        },
      ]);
      return;
    }
    if (noAi) {
      await searchDocs(text);
      return;
    }
    setSending(true);
    const stamp = Date.now();
    const userId = `user-${stamp}`;
    const replyId = `reply-${stamp}`;
    liveReplies.current.add(replyId);
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
      { id: replyId, role: "assistant", content: "" },
    ]);
    const update = (fn: (m: HelpMessage) => HelpMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));
    const dropEmptyReply = () =>
      setMessages((prev) =>
        prev.filter((m) => m.id !== replyId || m.content.trim())
      );

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      // "Ask … instead" picks the video or channel it names (the state
      // catches up after this render), or answers this one turn from Horde.
      const video =
        instead?.kind === "video"
          ? instead.video
          : instead?.kind === "channel"
            ? null
            : pickedVideo;
      const channels =
        instead?.kind === "channel"
          ? [instead.channel]
          : instead?.kind === "video"
            ? []
            : ask.scope;
      const params = {
        threadId: ask.threadId,
        channelIds: channels.map((c) => c.id),
        pageChannelId: pageAsk?.id ?? null,
        pageVideoId: pageAsk ? (pageChannel?.videoId ?? null) : null,
        answerFrom:
          instead?.kind === "horde" || instead?.kind === "video"
            ? instead.kind
            : null,
        video,
        // Nothing picked: the watch page's video.
        pageVideo: auto && !instead ? pageVideoHere : null,
        page: currentPage(),
        dataConsent: consent,
      };
      const handlers = {
        signal: ac.signal,
        onEvent: (event: Record<string, unknown>) => {
          if (event.type === "thread" && typeof event.id === "number") {
            const threadId = event.id;
            setAsk((a) => ({ ...a, threadId }));
          } else if (event.type === "scope") {
            const scope = parseScopeChannels(event.channels);
            const video = parseAskVideo(event.video);
            // A picked video stays the source: an answer from Horde or the
            // channel does not replace it (the reply's byline says which).
            setAsk((a) => (a.video ? a : { ...a, scope }));
            // A channel answer: the model's own numbers stay hidden until the
            // renumbered answer and its references arrive.
            if (scope.length)
              update((m) => ({ ...m, references: [], channels: scope }));
            if (video) update((m) => ({ ...m, video }));
            // A stream's saved AI row is made (or its expiry pushed back)
            // by a question about it: the watch page shows until when.
            if (video?.url)
              void queryClient.invalidateQueries({
                queryKey: queryKeys.preview.ai(video.url),
              });
          } else if (
            event.type === "status" &&
            typeof event.text === "string"
          ) {
            const status = event.text;
            update((m) => ({ ...m, status }));
          } else if (event.type === "references") {
            const references = parseReferences(event.references);
            const channels = parseScopeChannels(event.channels);
            update((m) => ({ ...m, references, channels }));
          } else if (event.type === "sources") {
            const sources = parseSources(event.sources);
            update((m) => ({ ...m, sources }));
          } else if (event.type === "token" && typeof event.text === "string") {
            const piece = event.text;
            update((m) => ({ ...m, content: m.content + piece }));
          } else if (event.type === "done") {
            const msg = event.message as { content?: unknown } | undefined;
            if (typeof msg?.content === "string") {
              const content = msg.content;
              update((m) => ({ ...m, content }));
            }
          } else if (event.type === "error") {
            setError(
              typeof event.detail === "string" ? event.detail : "Chat failed"
            );
            dropEmptyReply();
          }
        },
      };
      try {
        await api.streamAsk(text, params, handlers);
      } catch (err) {
        // The conversation was deleted (elsewhere, or empty): start a new one.
        if (!(err instanceof ApiError && err.status === 404 && params.threadId))
          throw err;
        await api.streamAsk(text, { ...params, threadId: null }, handlers);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Chat failed");
      }
      dropEmptyReply();
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
      inputRef.current?.focus();
    }
  }

  /** Without AI: the documentation pages and settings that match. */
  async function searchDocs(text: string) {
    const stamp = Date.now();
    setSending(true);
    setMessages((prev) => [
      ...prev,
      { id: `user-${stamp}`, role: "user", content: text },
    ]);
    try {
      const found = await api.searchHelp(text, currentPage());
      setMessages((prev) => [
        ...prev,
        {
          id: `reply-${stamp}`,
          role: "assistant",
          content: found.answer,
          sources: parseSources(found.sources),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  /** A new conversation, on the source picked (or the channel page's). */
  function clear() {
    if (sending) return;
    setMessages([]);
    setError(null);
    setShowHistory(false);
    setAsk((a) => ({
      threadId: null,
      ...(a.picked ?? AUTO),
      picked: a.picked,
    }));
    removeItem(HELP_CHAT_STORAGE_KEY, "session");
    inputRef.current?.focus();
  }

  async function openThread(id: number) {
    if (sending) return;
    setError(null);
    try {
      const thread = await api.askThread(id);
      setMessages(
        thread.messages.map((m) => ({
          id: `saved-${m.id}`,
          role: m.role,
          content: m.content,
          ...savedSources(m.sources),
        }))
      );
      const kept = thread.scope as { channels?: unknown; video?: unknown };
      // A picked video is the source even when channels answered last.
      const video = parseAskVideo(kept.video);
      const scope = video ? [] : parseScopeChannels(kept.channels);
      setAsk((a) => ({
        ...a,
        threadId: thread.id,
        scope,
        video,
      }));
      setShowHistory(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open it");
    }
  }

  async function deleteThread(id: number) {
    try {
      await api.deleteAskThread(id);
      if (ask.threadId === id) clear();
      void threadsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete it");
    }
  }

  const threadsQuery = useQuery({
    queryKey: queryKeys.ask.threads,
    queryFn: ({ signal }) => api.askThreads({ signal }),
    enabled: showHistory,
    staleTime: 0,
  });
  const askChannels = useQuery({
    queryKey: queryKeys.ask.channels,
    queryFn: ({ signal }) => api.askChannels({ signal }),
    staleTime: 60_000,
  }).data?.items;
  // The page's channel, when Ask has indexed it and the page is still showing.
  const pageFound =
    pageChannel && pageChannel.pathname === location.pathname
      ? findAskChannel(
          askChannels ?? [],
          pageChannel.channelUrl,
          pageChannel.channelName
        )
      : null;
  const pageAsk = pageFound && pageFound.passages > 0 ? pageFound : null;
  const pageName = pageAsk?.channel_name || null;
  // Channel answers need AI; without it every answer is a docs search.
  const scoped = noAi ? [] : ask.scope;
  const channelNames = scoped
    .map((c) => c.name)
    .filter(Boolean)
    .join(", ");
  // The channels Ask can answer from, for the source menu.
  const askable: AskScopeChannel[] = (askChannels ?? [])
    .filter((c) => c.passages > 0)
    .map((c) => ({ id: c.id, name: c.channel_name || c.channel_url }));
  // Answers about a video need AI and the AI video chat switch.
  const appSettings = useQuery(appSettingsQuery()).data;
  const videoChat = !noAi && appSettings?.ai.ai_chat !== false;
  const pickedVideo = videoChat ? (ask.video ?? null) : null;
  const auto = !scoped.length && !pickedVideo;
  // The watch page's video, while that page is showing.
  const pageVideoHere =
    videoChat && pageVideo && pageVideo.pathname === location.pathname
      ? pageVideo.video
      : null;
  // The video playing (a stream Ask can read is a YouTube one).
  const playingNow = videoChat ? playingVideo(current, stream) : null;
  const playing =
    playingNow && (playingNow.library_id != null || playingNow.youtube_id)
      ? playingNow
      : null;
  // Nothing picked on the watch page: questions go to its video. On a
  // channel's page: its videos' questions go to the channel.
  const pageVideoAuto = auto && !!pageVideoHere;
  const pageAuto = !noAi && auto && !pageVideoHere ? pageName : null;
  const videoTitle = pickedVideo?.title || "this video";
  // What the chat is focused on, shown beside the title with a way out.
  const focus = pickedVideo
    ? videoTitle
    : scoped.length
      ? channelNames || "a channel"
      : null;
  const placeholder = scoped.length
    ? `Ask ${channelNames || "this channel"}…`
    : pickedVideo
      ? `Ask about ${videoTitle}…`
      : pageVideoAuto
        ? "Ask this video or Horde…"
        : pageAuto
          ? `Ask ${pageAuto} or Horde…`
          : !noAi && askable.length
            ? "Ask how to use Horde, or name a channel…"
            : "Ask how to use Horde…";

  /** × on the focus chip: back to asking about anything. */
  function clearFocus() {
    setAsk((a) => ({ ...a, ...AUTO, picked: AUTO }));
    inputRef.current?.focus();
  }

  // Under the latest reply: the same question from the other likely sources.
  const lastReply = messages[messages.length - 1];
  const lastQuestion = messages[messages.length - 2];
  const insteads: { label: string; instead: Instead }[] = [];
  if (
    !noAi &&
    !sending &&
    lastReply?.role === "assistant" &&
    lastReply.content.trim() &&
    lastQuestion?.role === "user" &&
    !isWhatCanYouDo(lastQuestion.content)
  ) {
    const from = lastReply.video
      ? "video"
      : lastReply.references
        ? "channel"
        : "horde";
    const video = pickedVideo ?? pageVideoHere ?? playing;
    const channel = pageAsk
      ? { id: pageAsk.id, name: pageAsk.channel_name || pageAsk.channel_url }
      : null;
    if (from !== "video" && video)
      insteads.push({
        label: `Ask ${video.title || "this video"} instead`,
        instead: { kind: "video", video },
      });
    if (from !== "channel" && channel)
      insteads.push({
        label: `Ask ${channel.name} instead`,
        instead: { kind: "channel", channel },
      });
    if (from !== "horde")
      insteads.push({ label: "Ask Horde instead", instead: { kind: "horde" } });
  }

  function askInstead(instead: Instead) {
    if (!lastQuestion) return;
    if (instead.kind !== "horde") {
      const next: AskSourceState =
        instead.kind === "video"
          ? { scope: [], video: instead.video }
          : { scope: [instead.channel], video: null };
      setAsk((a) => ({ ...a, ...next, picked: next }));
    }
    void send(lastQuestion.content, instead);
  }

  // On a phone the panel covers the page: get out of the way of a link.
  const onNavigate = () => {
    if (isMobile) onClose();
  };
  const renderers: InlineRenderers = {
    token: (raw, key) => (
      <HelpTokenLink
        key={key}
        raw={raw}
        catalog={catalog}
        onNavigate={onNavigate}
      />
    ),
    link: (href, label, key) => {
      if (isAppPath(href)) {
        return (
          <Link
            key={key}
            to={href}
            onClick={onNavigate}
            className="text-accent underline underline-offset-2"
          >
            {label}
          </Link>
        );
      }
      // A reply can be steered by text it read (a video description), so a
      // link off the site names where it goes instead of passing for one of
      // Horde's own.
      const safe = markdownHref(href);
      const host = safe ? offSiteHost(safe) : null;
      if (!safe || !host) return null;
      return (
        <span key={key}>
          <a
            href={safe}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {label}
          </a>{" "}
          <span className="text-muted">({host})</span>
        </span>
      );
    },
  };
  const lastId = messages[messages.length - 1]?.id;

  return (
    <>
      <PanelHeader
        title="Ask"
        addon={
          focus && (
            <span
              className="-my-0.5 flex min-w-0 items-center gap-1 rounded-md bg-ink-800 py-0.5 pl-2 pr-1 text-sm font-semibold text-accent"
              data-horde="ask-focus"
            >
              <span className="truncate">{focus}</span>
              <button
                type="button"
                onClick={clearFocus}
                disabled={sending}
                aria-label={`Stop asking about ${focus}`}
                title="Ask about anything"
                className="shrink-0 rounded-sm p-0.5 text-muted hover:text-accent disabled:opacity-40"
              >
                <CloseIcon className="h-3 w-3" />
              </button>
            </span>
          )
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowHistory((v) => !v)}
              disabled={sending}
              aria-pressed={showHistory}
              className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-accent disabled:opacity-40"
            >
              History
            </button>
            {(messages.length > 0 || ask.threadId != null) && (
              <button
                type="button"
                onClick={clear}
                disabled={sending}
                className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-accent disabled:opacity-40"
              >
                New chat
              </button>
            )}
          </>
        }
      />
      <div
        ref={listRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (axe scrollable-region-focusable)
        tabIndex={0}
        aria-label="Conversation"
        className="horde-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
        aria-live="polite"
      >
        {showHistory && (
          <div className="space-y-1" data-horde="ask-history">
            <p className="text-xs font-semibold text-gray-400">
              Your conversations
            </p>
            {threadsQuery.isLoading && <TypingDots label="Loading" />}
            {threadsQuery.data?.items.length === 0 && (
              <p className="text-xs text-muted">None yet.</p>
            )}
            <ul className="space-y-1">
              {threadsQuery.data?.items.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void openThread(t.id)}
                    className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm text-gray-300 hover:bg-ink-800 hover:text-accent"
                  >
                    {t.title || "Untitled"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteThread(t.id)}
                    aria-label={`Delete “${t.title}”`}
                    className="shrink-0 rounded-md px-1.5 py-1 text-xs text-muted hover:text-danger"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!showHistory &&
          messages.length === 0 &&
          !sending &&
          scoped.length > 0 && (
            <p className="text-sm text-gray-400">
              Ask what {channelNames || "this channel"} said about something.
              Answers come only from the indexed videos, with a numbered
              reference to the moment for each point.
            </p>
          )}
        {!showHistory &&
          messages.length === 0 &&
          !sending &&
          scoped.length === 0 &&
          (pickedVideo || pageVideoAuto) && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Ask about{" "}
                {pickedVideo ? (
                  <span className="text-gray-200">{videoTitle}</span>
                ) : (
                  "this video"
                )}
                : what it covers, what was said in it, what viewers commented.
                Questions about Horde or your library still go to Horde, and
                questions about a whole channel to that channel when Ask indexes
                it.
              </p>
              <div className="flex flex-wrap gap-2">
                {VIDEO_PROMPTS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-left text-xs text-gray-300 hover:border-accent hover:text-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        {!showHistory &&
          messages.length === 0 &&
          !sending &&
          scoped.length === 0 &&
          !pickedVideo &&
          !pageVideoAuto && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Ask how to use, set up or fix Horde. I can also take you to a
                setting or change it, look at your downloads and library, make
                playlists and restyle the app. The page you are on is sent with
                your question.
                {!noAi && askable.length
                  ? " To ask what a channel said in its videos, name it."
                  : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                {prompts.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-left text-xs text-gray-300 hover:border-accent hover:text-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        {!showHistory &&
          messages.map((m) => {
            const waiting =
              sending && m.role === "assistant" && !m.content.trim();
            return (
              <div
                key={m.id}
                className={
                  m.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={
                    m.role === "user"
                      ? "w-fit max-w-[85%] rounded-lg bg-accent/10 px-3 py-2 text-sm text-gray-200"
                      : "w-fit max-w-full min-w-0 rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-300"
                  }
                >
                  <p
                    className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted"
                    data-horde="ask-byline"
                  >
                    {m.role === "user" ? "You" : answeredFrom(m)}
                  </p>
                  {waiting ? (
                    <TypingDots
                      label={m.status || "Looking it up"}
                      className="py-1"
                    />
                  ) : m.role === "user" ? (
                    <AiMarkdown
                      text={m.content}
                      className="space-y-2 text-sm text-gray-200"
                    />
                  ) : (
                    <AssistantReply
                      content={m.content}
                      streaming={sending && m.id === lastId}
                      renderers={renderers}
                      catalog={catalog}
                      references={m.references}
                      untrusted={!!(m.references || m.video)}
                      autoApply={liveReplies.current.has(m.id)}
                      onNavigate={onNavigate}
                    />
                  )}
                  {m.role === "assistant" &&
                    !!m.sources?.length &&
                    !waiting && (
                      <details className="mt-2 text-xs text-muted">
                        <summary className="cursor-pointer select-none hover:text-gray-300">
                          Sources ({m.sources.length})
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {m.sources.map((s) => (
                            <li key={s.path} className="truncate">
                              <a
                                href={markdownHref(s.url)}
                                target="_blank"
                                rel="noreferrer"
                                title={s.path}
                                className="text-accent underline-offset-2 hover:underline"
                              >
                                {s.title}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                </div>
              </div>
            );
          })}
        {!showHistory && insteads.length > 0 && (
          <div
            className="-mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-1 text-xs"
            data-horde="ask-instead"
          >
            {insteads.map(({ label, instead }) => (
              <button
                key={label}
                type="button"
                onClick={() => askInstead(instead)}
                className="text-muted underline-offset-2 hover:text-accent hover:underline"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-warning">
            {error}
          </p>
        )}
      </div>

      {noAi && (
        <p
          className="border-t border-ink-700 px-3 pt-2 text-xs text-muted"
          data-horde="help-no-ai"
        >
          AI is not set up, so answers are searches of Horde&rsquo;s
          documentation.
        </p>
      )}
      <form
        className="flex items-end gap-2 border-t border-ink-700 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Your question
        </label>
        <textarea
          id={inputId}
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            promptPos.current = null;
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
              return;
            }
            // Up on the first line / Down on the last: earlier questions.
            if (
              (e.key !== "ArrowUp" && e.key !== "ArrowDown") ||
              e.shiftKey ||
              e.altKey ||
              e.metaKey ||
              e.ctrlKey
            )
              return;
            const box = e.currentTarget;
            const up = e.key === "ArrowUp";
            const caret = box.selectionStart;
            const onEdge = up
              ? !box.value.slice(0, caret).includes("\n")
              : !box.value.slice(box.selectionEnd).includes("\n");
            if (!onEdge) return;
            const step = stepPromptHistory(
              promptHistory.current ?? [],
              promptPos.current,
              up ? -1 : 1
            );
            if (!step) return;
            e.preventDefault();
            if (promptPos.current === null) promptStash.current = draft;
            promptPos.current = step.pos;
            const text = step.text ?? promptStash.current;
            setDraft(text);
            requestAnimationFrame(() =>
              box.setSelectionRange(text.length, text.length)
            );
          }}
          rows={2}
          maxLength={4000}
          // Read-only, not disabled: disabling drops focus, and the user
          // would have to click back in for the next question.
          readOnly={sending}
          placeholder={placeholder}
          className="horde-scrollbar min-h-10 flex-1 resize-none rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-base text-gray-200 placeholder:text-muted focus:border-accent focus:outline-hidden md:text-sm"
        />
        {sending ? (
          <button
            type="button"
            onClick={() => abortRef.current?.abort()}
            className={BUTTON}
          >
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim()} className={BUTTON}>
            Send
          </button>
        )}
      </form>
    </>
  );
}
