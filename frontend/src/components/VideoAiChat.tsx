import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import Collapse from "./Collapse";
import type { VideoAiChatMessage } from "../types";

interface Props {
  videoId: number;
  /** Cached AI summary shown as a seed bubble before any chat turns. */
  summary?: string | null;
  hasSubtitles: boolean;
  open: boolean;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  onClose?: () => void;
  showToast: (msg: string) => void;
}

type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  seed?: boolean;
};

function toDisplay(m: VideoAiChatMessage): DisplayMessage {
  return {
    id: String(m.id ?? `${m.role}-${m.created_at ?? Math.random()}`),
    role: m.role,
    content: m.content,
  };
}

export default function VideoAiChat({
  videoId,
  summary,
  hasSubtitles,
  open,
  expanded,
  onExpandedChange,
  onClose,
  showToast,
}: Props) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getVideoAiChat(videoId)
      .then((res) => {
        if (cancelled) return;
        setMessages((res.messages || []).map(toDisplay));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load chat");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [videoId]);

  useEffect(() => {
    if (!open || !expanded) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, expanded, sending]);

  useEffect(() => {
    if (open && expanded) {
      inputRef.current?.focus();
    }
  }, [open, expanded]);

  const seedSummary = (summary || "").trim();
  const showSeed =
    !!seedSummary && messages.length === 0 && !loading && !sending;

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft("");
    setError(null);
    setSending(true);

    const tempUserId = `local-user-${Date.now()}`;
    const tempAsstId = `local-asst-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: "user", content: text },
      { id: tempAsstId, role: "assistant", content: "" },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await api.streamVideoAiChat(videoId, text, {
        signal: ac.signal,
        onEvent: (event) => {
          const type = String(event.type || "");
          if (type === "user" && event.message && typeof event.message === "object") {
            const msg = event.message as VideoAiChatMessage;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempUserId
                  ? {
                      id: String(msg.id ?? tempUserId),
                      role: "user",
                      content: msg.content || text,
                    }
                  : m
              )
            );
          } else if (type === "token" && typeof event.text === "string") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAsstId
                  ? { ...m, content: m.content + event.text }
                  : m
              )
            );
          } else if (
            type === "done" &&
            event.message &&
            typeof event.message === "object"
          ) {
            const msg = event.message as VideoAiChatMessage;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAsstId
                  ? {
                      id: String(msg.id ?? tempAsstId),
                      role: "assistant",
                      content: msg.content || m.content,
                    }
                  : m
              )
            );
          } else if (type === "error") {
            const detail =
              typeof event.detail === "string"
                ? event.detail
                : "Chat failed";
            setError(detail);
            showToast(detail);
            setMessages((prev) =>
              prev.filter((m) => m.id !== tempAsstId || m.content.trim())
            );
          }
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setMessages((prev) =>
          prev.filter((m) => m.id !== tempAsstId || m.content.trim())
        );
      } else {
        const msg = err instanceof Error ? err.message : "Chat failed";
        setError(msg);
        showToast(msg);
        setMessages((prev) =>
          prev.filter(
            (m) => m.id !== tempUserId && (m.id !== tempAsstId || m.content.trim())
          )
        );
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
    }
  }

  async function clearThread() {
    if (sending) return;
    try {
      await api.clearVideoAiChat(videoId);
      setMessages([]);
      setError(null);
      showToast("Chat cleared");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not clear chat";
      showToast(msg);
    }
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setSending(false);
    showToast("Reply cancelled");
  }

  if (!open) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 py-2">
        <button
          type="button"
          onClick={() => onExpandedChange(!expanded)}
          className="ui-panel-toggle ui-interactive flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
        >
          <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
            <span>Ask about this video</span>
            <span>{expanded ? "▲" : "▼"}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {sending ? (
            <button
              type="button"
              onClick={cancel}
              className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-amber-500/50 hover:text-amber-300"
            >
              Cancel
            </button>
          ) : (
            messages.length > 0 && (
              <button
                type="button"
                onClick={() => void clearThread()}
                className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
              >
                Clear
              </button>
            )
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
              aria-label="Close chat"
            >
              Close
            </button>
          )}
        </div>
      </div>
      <Collapse open={expanded}>
        <div className="ui-panel isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
          <div
            ref={listRef}
            className="horde-scrollbar max-h-72 space-y-3 overflow-y-auto px-4 py-3"
          >
            {loading && (
              <p className="text-xs text-gray-500">Loading chat…</p>
            )}
            {!loading && showSeed && (
              <div className="rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-400">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  From summary
                </p>
                <p className="whitespace-pre-wrap">{seedSummary}</p>
              </div>
            )}
            {!loading &&
              !showSeed &&
              messages.length === 0 &&
              !sending && (
                <p className="text-xs text-gray-500">
                  Ask anything about this video
                  {!hasSubtitles
                    ? " — captions not downloaded, answers will use title and description only."
                    : "."}
                </p>
              )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={
                  m.role === "user"
                    ? "ml-6 rounded-lg bg-accent/10 px-3 py-2 text-sm text-gray-200"
                    : "mr-6 rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-300"
                }
              >
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {m.role === "user" ? "You" : "AI"}
                </p>
                <p className="whitespace-pre-wrap">
                  {m.content || (sending && m.role === "assistant" ? "…" : "")}
                </p>
              </div>
            ))}
            {error && (
              <p className="text-xs text-amber-400/90">{error}</p>
            )}
          </div>
          <div className="border-t border-ink-700 px-3 py-2">
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                disabled={sending}
                placeholder="Ask about this video…"
                className="horde-scrollbar min-h-[2.5rem] flex-1 resize-none rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      </Collapse>
    </div>
  );
}
