import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { getJson, removeItem, setJson } from "../storage";
import { backdropClick } from "../utils";
import AiMarkdown from "./AiMarkdown";
import { markdownHref } from "./aiMarkdownParse";
import {
  HELP_CHAT_STORAGE_KEY,
  HELP_SUGGESTIONS,
  type HelpMessage,
  historyForRequest,
  isHelpThread,
  parseSources,
} from "./helpChat";
import TypingDots from "./TypingDots";

interface Props {
  /** Asked as soon as the dialog opens (from the Settings footer box). */
  initialQuestion?: string;
  onClose: () => void;
}

const BUTTON =
  "ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Ask about Horde: a chat that answers from this server's docs and source.
 * The conversation lives in this tab (sessionStorage) and is sent with each
 * question.
 */
export default function HelpChatDialog({ initialQuestion, onClose }: Props) {
  const titleId = useId();
  const inputId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [messages, setMessages] = useState<HelpMessage[]>(() =>
    getJson(HELP_CHAT_STORAGE_KEY, isHelpThread, [], "session")
  );
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusTrap(panelRef, { onEscape: onClose });

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // Only finished turns: a half-streamed reply is not worth restoring.
    if (!sending) setJson(HELP_CHAT_STORAGE_KEY, messages, "session");
  }, [messages, sending]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || sending) return;
    setDraft("");
    setError(null);
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
      await api.streamHelpChat(text, history, {
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

  // The latest `send`, for the one-shot effect below.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!initialQuestion?.trim()) return;
    // Deferred so StrictMode's mount, unmount, mount sends it once: the
    // unmount clears the timer instead of aborting a request already sent.
    const timer = window.setTimeout(
      () => void sendRef.current(initialQuestion)
    );
    return () => window.clearTimeout(timer);
  }, [initialQuestion]);

  function clear() {
    if (sending) return;
    setMessages([]);
    setError(null);
    removeItem(HELP_CHAT_STORAGE_KEY, "session");
    inputRef.current?.focus();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-panel ui-panel-legible flex h-[min(40rem,calc(100dvh-2rem))] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-ink-900 shadow-xl outline-hidden ring-1 ring-ink-600"
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-700 px-5 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-gray-100">
              Ask about Horde
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Answers come from this server’s docs and source code, and can be
              wrong. Check the linked pages.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={clear}
                disabled={sending}
                className={BUTTON}
              >
                Clear
              </button>
            )}
            <button type="button" onClick={onClose} className={BUTTON}>
              Close
            </button>
          </div>
        </div>

        <div
          ref={listRef}
          className="horde-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4"
          aria-live="polite"
        >
          {messages.length === 0 && !sending && (
            <div className="space-y-3">
              <p className="text-sm text-gray-400">
                Ask how to use, set up or troubleshoot Horde, or how something
                works under the hood.
              </p>
              <div className="flex flex-wrap gap-2">
                {HELP_SUGGESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => void send(q)}
                    className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-xs text-gray-300 hover:border-accent hover:text-accent"
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
                      ? "w-fit max-w-[80%] rounded-lg bg-accent/10 px-3 py-2 text-sm text-gray-200"
                      : "w-fit max-w-[95%] min-w-0 rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-300"
                  }
                >
                  <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                    {m.role === "user" ? "You" : "Horde"}
                  </p>
                  {waiting ? (
                    <TypingDots label="Looking it up" className="py-1" />
                  ) : (
                    <AiMarkdown
                      text={m.content}
                      className={
                        m.role === "user"
                          ? "space-y-2 text-sm text-gray-200"
                          : "space-y-2 text-sm text-gray-300"
                      }
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
            <p role="alert" className="text-xs text-amber-400/90">
              {error}
            </p>
          )}
        </div>

        <form
          className="flex items-end gap-2 border-t border-ink-700 px-4 py-3"
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
            disabled={sending}
            placeholder="Ask about Horde…"
            className="horde-scrollbar min-h-10 flex-1 resize-none rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-200 placeholder:text-muted focus:border-accent focus:outline-hidden"
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
      </div>
    </div>,
    document.body
  );
}
