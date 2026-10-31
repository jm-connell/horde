import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import {
  usePlaybackLayout,
  usePlaybackSession,
} from "../context/PlaybackContext";
import type { PageDetail } from "../context/HelpChatContext";
import type { HelpCatalog } from "../types";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { queryKeys } from "../queries/keys";
import { getJson, removeItem, setJson } from "../storage";
import AiMarkdown, { type InlineRenderers } from "./AiMarkdown";
import { markdownHref } from "./aiMarkdownParse";
import {
  CssPreviewCard,
  HelpActionCards,
  HelpTokenLink,
} from "./HelpChatActions";
import {
  HELP_CHAT_STORAGE_KEY,
  HELP_PANEL_ID,
  type HelpMessage,
  historyForRequest,
  isHelpThread,
  parseSources,
} from "./helpChat";
import {
  clampHelpFrame,
  defaultHelpFrame,
  type HelpFrame,
  resizeFromTopLeft,
} from "./helpChatLayout";
import { describePage } from "./helpPage";
import {
  capabilitiesAnswer,
  pickPrompts,
  promptAllowed,
  WHAT_CAN_YOU_DO,
} from "./helpPrompts";
import { cssBlocks, splitActions } from "./helpTokens";
import { CloseIcon } from "./icons";
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

function isWhatCanYouDo(text: string): boolean {
  const plain = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z ]/g, "")
      .trim();
  return plain(text) === plain(WHAT_CAN_YOU_DO);
}

interface Props {
  /** Where the user dragged or resized it to; null until they do. */
  frame: HelpFrame | null;
  onFrameChange: (frame: HelpFrame) => void;
  /** The current page's note on what is showing (e.g. the Settings tab). */
  pageDetail: () => PageDetail | null;
  /** Focus the question box (false when restored open after a reload). */
  focusOnOpen: boolean;
  onClose: () => void;
}

const BUTTON =
  "ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

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

/**
 * One reply: its text with links in place, then (once it has finished
 * streaming) a card for each action it offers and each CSS block.
 */
function AssistantReply({
  content,
  streaming,
  renderers,
  catalog,
  onNavigate,
}: {
  content: string;
  streaming: boolean;
  renderers: InlineRenderers;
  catalog: HelpCatalog | undefined;
  onNavigate: () => void;
}) {
  const { text, actions } = splitActions(content);
  return (
    <>
      <AiMarkdown
        text={text}
        render={renderers}
        className="space-y-2 text-sm text-gray-300"
      />
      {!streaming && (
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
 * Ask about Horde: a chat in the corner that answers from this server's docs
 * and source. It floats over every page (drag it by its header, resize it
 * from the top-left corner) and tells the server which page the user is on.
 * The conversation lives in this tab (sessionStorage) and is sent with each
 * question.
 */
export default function HelpChatPanel({
  frame,
  onFrameChange,
  pageDetail,
  focusOnOpen,
  onClose,
}: Props) {
  const titleId = useId();
  const inputId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [messages, setMessages] = useState<HelpMessage[]>(() =>
    getJson(HELP_CHAT_STORAGE_KEY, isHelpThread, [], "session")
  );
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
  }).data;
  // Settings → Library; the server holds the data back from a cloud AI when
  // only "local" was allowed.
  const consent = settings.helpChatData;

  const location = useLocation();
  const { current, stream, miniPlayerActive } = usePlaybackSession();
  const { miniPlayerRect } = usePlaybackLayout();
  const isMobile = useIsMobile();
  const { vw, vh } = useViewport();
  const box = frame
    ? clampHelpFrame(frame, vw, vh)
    : defaultHelpFrame(vw, vh, miniPlayerRect);

  const autoFocusRef = useRef(focusOnOpen);
  useEffect(() => {
    if (autoFocusRef.current) inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, []);
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

  // Escape closes it while focus is inside (it is not modal, so only then).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    // Only finished turns: a half-streamed reply is not worth restoring.
    if (!sending) setJson(HELP_CHAT_STORAGE_KEY, messages, "session");
  }, [messages, sending]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

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
    if ((e.target as HTMLElement).closest("button, a")) return;
    const start = box;
    startDrag(e, (dx, dy) =>
      clampHelpFrame(
        { ...start, left: start.left + dx, top: start.top + dy },
        window.innerWidth,
        window.innerHeight
      )
    );
  }

  function onResizePointerDown(e: React.PointerEvent<HTMLElement>) {
    const start = box;
    startDrag(e, (dx, dy) =>
      resizeFromTopLeft(start, dx, dy, window.innerWidth, window.innerHeight)
    );
  }

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
    setSending(true);
    const history = historyForRequest(messages);
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
      await api.streamHelpChat(text, history, currentPage(), consent, {
        signal: ac.signal,
        onEvent: (event) => {
          if (event.type === "sources") {
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
      });
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

  function clear() {
    if (sending) return;
    setMessages([]);
    setError(null);
    removeItem(HELP_CHAT_STORAGE_KEY, "session");
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

  const placement: React.CSSProperties | undefined = isMobile
    ? undefined
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
      aria-labelledby={titleId}
      id={HELP_PANEL_ID}
      data-horde="help-chat"
      ref={panelRef}
      style={placement}
      className={`ui-panel ui-panel-legible fixed z-45 flex flex-col overflow-hidden rounded-xl bg-ink-900 shadow-2xl ring-1 ring-ink-600 ${
        isMobile
          ? "inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom),var(--horde-bottom-bar,0px))] h-[min(36rem,75dvh)]"
          : ""
      }`}
    >
      {!isMobile && (
        <div
          className="absolute left-0 top-0 z-10 h-4 w-4 cursor-nwse-resize touch-none"
          title="Drag to resize"
          aria-hidden="true"
          onPointerDown={onResizePointerDown}
        />
      )}
      <header
        className={`flex items-center justify-between gap-2 border-b border-ink-700 px-4 py-2.5 ${
          isMobile ? "" : "cursor-move touch-none select-none"
        }`}
        onPointerDown={isMobile ? undefined : onHeaderPointerDown}
      >
        <h2
          id={titleId}
          className="min-w-0 truncate text-sm font-semibold text-gray-100"
        >
          Ask about Horde
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clear}
              disabled={sending}
              className="rounded-md px-2 py-1.5 text-xs text-muted hover:text-accent disabled:opacity-40"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:text-accent"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <div
        ref={listRef}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (axe scrollable-region-focusable)
        tabIndex={0}
        aria-label="Conversation"
        className="horde-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3"
        aria-live="polite"
      >
        {messages.length === 0 && !sending && (
          <div className="space-y-3">
            <p className="text-sm text-gray-400">
              Ask how to use, set up or fix Horde. I can also take you to a
              setting or change it, look at your downloads and library, make
              playlists and restyle the app. The page you are on is sent with
              your question.
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
        {messages.map((m) => {
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
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {m.role === "user" ? "You" : "Horde"}
                </p>
                {waiting ? (
                  <TypingDots label="Looking it up" className="py-1" />
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
                    onNavigate={onNavigate}
                  />
                )}
                {m.role === "assistant" && !!m.sources?.length && !waiting && (
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
          placeholder="Ask about Horde…"
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
    </section>,
    document.body
  );
}
