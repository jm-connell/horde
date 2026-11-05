import { useEffect, useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ApiError, api } from "../api";
import { useAuth } from "../context/AuthContext";
import { usePlaybackSession } from "../context/PlaybackContext";
import type {
  ChannelRequest,
  PageChannel,
  PageDetail,
} from "../context/HelpChatContext";
import { findAskChannel } from "../pages/ask/askLinks";
import type { HelpCatalog } from "../types";
import { useSettings } from "../hooks/useSettings";
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
import AskSourcePicker, { type AskSource } from "./AskSourcePicker";
import {
  ASK_CHAT_STORAGE_KEY,
  type AskChatState,
  type AskReference,
  type AskScopeChannel,
  type AskSourceState,
  HELP_CHAT_STORAGE_KEY,
  type HelpMessage,
  isAskState,
  isHelpThread,
  parseReferences,
  parseScopeChannels,
  parseSources,
  savedSources,
} from "./helpChat";
import { describePage } from "./helpPage";
import {
  capabilitiesAnswer,
  pickPrompts,
  promptAllowed,
  WHAT_CAN_YOU_DO,
} from "./helpPrompts";
import { cssBlocks, splitActions } from "./helpTokens";
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
const AUTO: AskSourceState = { scope: [], horde: false };

/** Who an answer is from: the channels it quotes, else Horde. */
function answeredFrom(m: HelpMessage): string {
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
  /** "Ask <channel>" from a channel page: a new conversation about it. */
  channelRequest?: ChannelRequest | null;
  /** The channel (and video) the current page is about. */
  pageChannel?: PageChannel | null;
  pendingChannelRequest?: () => ChannelRequest | null;
  consumeChannelRequest?: (seq: number) => void;
  onClose: () => void;
}

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
  onNavigate,
}: {
  content: string;
  streaming: boolean;
  renderers: InlineRenderers;
  catalog: HelpCatalog | undefined;
  /** Ask channel answers: markers become links to these. */
  references?: AskReference[];
  onNavigate: () => void;
}) {
  const { text, actions } = splitActions(content);
  const byN = new Map((references ?? []).map((r) => [r.n, r]));
  // A channel answer is built from captions anyone could have written, so its
  // help tokens stay text and it offers no actions or CSS.
  const render: InlineRenderers = references
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
      {!streaming && !references && (
        <>
          <HelpActionCards
            actions={actions}
            catalog={catalog}
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
 * source shows above the question box, where the user can pick another. It
 * floats over every page (drag it by its header, resize it from the top-left
 * corner) and tells the server which page the user is on. The conversation
 * lives in this tab (sessionStorage) and on the server.
 */
export default function HelpChatPanel({
  pageDetail,
  focusOnOpen,
  channelRequest = null,
  pageChannel = null,
  pendingChannelRequest = () => null,
  consumeChannelRequest = () => {},
  onClose,
}: Props) {
  const inputId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Opened by "Ask <channel>": start on a new conversation about it. (The
  // panel mounts on open, so the request is already there; peeking, not
  // taking, keeps React's doubled initialisers harmless.)
  const [opening] = useState(() => pendingChannelRequest());
  const [messages, setMessages] = useState<HelpMessage[]>(() =>
    opening ? [] : getJson(HELP_CHAT_STORAGE_KEY, isHelpThread, [], "session")
  );
  // The saved conversation this tab shows, where it is answered from, and
  // the source last picked (kept with it, so a reopened panel has it too).
  const [ask, setAsk] = useState<AskChatState>(() => {
    if (!opening)
      return getJson(
        ASK_CHAT_STORAGE_KEY,
        isAskState,
        { threadId: null, scope: [] },
        "session"
      );
    const source = { scope: [opening.channel], horde: false };
    return { threadId: null, ...source, picked: source };
  });
  const [showHistory, setShowHistory] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isAdmin, can } = useAuth();
  const [settings] = useSettings();
  // A new set each time the panel opens (it mounts on open).
  const [prompts] = useState(() =>
    pickPrompts((p) => promptAllowed(p, { isAdmin, can }))
  );
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

  // "Ask <channel>" while the panel is open: a new conversation about it.
  useEffect(() => {
    const req = pendingChannelRequest();
    if (!req) return;
    consumeChannelRequest(req.seq);
    if (req.seq === opening?.seq) return; // started on it already
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    setShowHistory(false);
    const source = { scope: [req.channel], horde: false };
    setAsk({ threadId: null, ...source, picked: source });
    inputRef.current?.focus();
  }, [channelRequest, pendingChannelRequest, consumeChannelRequest, opening]);

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

  async function send(question: string) {
    const text = question.trim();
    if (!text || sending) return;
    setDraft("");
    setError(null);
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
      const params = {
        threadId: ask.threadId,
        channelIds: ask.scope.map((c) => c.id),
        pageChannelId: pageAsk?.id ?? null,
        pageVideoId: pageAsk ? (pageChannel?.videoId ?? null) : null,
        hordeOnly: !!ask.horde,
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
            setAsk((a) => ({ ...a, scope, horde: !scope.length && a.horde }));
            // A channel answer: the model's own numbers stay hidden until the
            // renumbered answer and its references arrive.
            if (scope.length)
              update((m) => ({ ...m, references: [], channels: scope }));
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
      const scope = parseScopeChannels(
        (thread.scope as { channels?: unknown }).channels
      );
      setAsk((a) => ({
        ...a,
        threadId: thread.id,
        scope,
        horde: !scope.length && a.horde,
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
  const showSource = !noAi && (askable.length > 0 || ask.scope.length > 0);
  const auto = !ask.horde && !scoped.length;
  // Nothing picked on a channel's page: its videos' questions go to it.
  const pageAuto = !noAi && auto ? pageName : null;
  const sourceLabel = scoped.length
    ? channelNames || "a channel"
    : ask.horde
      ? "Horde"
      : pageAuto
        ? `${pageAuto} or Horde`
        : "Horde or a named channel";
  const placeholder = scoped.length
    ? `Ask ${channelNames || "this channel"}…`
    : pageAuto
      ? `Ask ${pageAuto} or Horde…`
      : showSource && auto
        ? "Ask how to use Horde, or name a channel…"
        : "Ask how to use Horde…";

  function pickSource(source: AskSource) {
    const next =
      source === "auto"
        ? AUTO
        : source === "horde"
          ? { scope: [], horde: true }
          : { scope: [source], horde: false };
    setAsk((a) => ({ ...a, ...next, picked: next }));
    inputRef.current?.focus();
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
          scoped.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Ask how to use, set up or fix Horde. I can also take you to a
                setting or change it, look at your downloads and library, make
                playlists and restyle the app. The page you are on is sent with
                your question.
                {showSource
                  ? ask.horde
                    ? " To ask what a channel said in its videos, pick it below."
                    : " To ask what a channel said in its videos, name it or pick it below."
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
        {error && (
          <p role="alert" className="text-xs text-warning">
            {error}
          </p>
        )}
      </div>

      {showSource && (
        <AskSourcePicker
          label={sourceLabel}
          hint={
            pageAuto
              ? `Questions about its videos go to ${pageAuto}; the rest to Horde.`
              : undefined
          }
          autoDetail={
            pageName
              ? `${pageName} for its videos, Horde for the rest`
              : "Horde, or the channel a question names"
          }
          channels={askable}
          selected={
            ask.scope.length === 1
              ? ask.scope[0].id
              : ask.scope.length
                ? null
                : ask.horde
                  ? "horde"
                  : "auto"
          }
          disabled={sending}
          onPick={pickSource}
        />
      )}
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
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
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
