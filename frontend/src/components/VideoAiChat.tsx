import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { VideoAiChatMessage } from "../types";
import { formatUsdCost } from "../utils";
import AiMarkdown from "./AiMarkdown";
import TypingDots from "./TypingDots";

interface Props {
  videoId: number;
  /** Cached AI summary shown as a seed bubble before any chat turns. */
  summary?: string | null;
  hasSubtitles: boolean;
  /** When false, the chat body is hidden (panel still mounts for history). */
  active: boolean;
  showCosts?: boolean;
  showToast: (msg: string) => void;
}

type DisplayMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  cost?: number | null;
};

function toDisplay(m: VideoAiChatMessage): DisplayMessage {
  return {
    id: String(m.id ?? `${m.role}-${m.created_at ?? Math.random()}`),
    role: m.role,
    content: m.content,
    cost: typeof m.cost === "number" ? m.cost : null,
  };
}

export default function VideoAiChat({
  videoId,
  summary,
  hasSubtitles,
  active,
  showCosts = false,
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
    if (!active) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, active, sending]);

  useEffect(() => {
    if (active) {
      inputRef.current?.focus();
    }
  }, [active]);

  const seedSummary = (summary || "").trim();
  const showSeed =
    !!seedSummary && messages.length === 0 && !loading && !sending;

  const threadCost = useMemo(() => {
    let sum = 0;
    let saw = false;
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      if (typeof m.cost === "number" && m.cost >= 0) {
        sum += m.cost;
        saw = true;
      }
    }
    return saw ? sum : null;
  }, [messages]);
  const threadCostLabel =
    showCosts && threadCost != null ? formatUsdCost(threadCost) : "";

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
            const cost =
              typeof msg.cost === "number"
                ? msg.cost
                : typeof event.cost === "number"
                  ? event.cost
                  : null;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempAsstId
                  ? {
                      id: String(msg.id ?? tempAsstId),
                      role: "assistant",
                      content: msg.content || m.content,
                      cost,
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

  if (!active) return null;

  return (
    <div className="ui-panel isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
      {threadCostLabel && (
        <div className="flex items-center justify-end border-b border-ink-800/80 px-3 py-1">
          <span
            className="text-[10px] tabular-nums text-gray-600"
            title="Running OpenRouter cost for this chat"
            aria-label={`Chat cost ${threadCostLabel}`}
          >
            {threadCostLabel}
          </span>
        </div>
      )}
      <div
        ref={listRef}
        className="horde-scrollbar max-h-72 space-y-3 overflow-y-auto px-4 py-3"
      >
        {loading && (
          <div className="flex justify-center py-6">
            <TypingDots label="Loading chat" />
          </div>
        )}
        {!loading && showSeed && (
          <div className="flex justify-start">
            <div className="w-fit max-w-[90%] rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-400">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                From summary
              </p>
              <AiMarkdown
                text={seedSummary}
                className="space-y-2 text-sm text-gray-400"
              />
            </div>
          </div>
        )}
        {!loading &&
          !showSeed &&
          messages.length === 0 &&
          !sending && (
            <p className="text-xs text-gray-500">
              Ask this video anything
              {!hasSubtitles
                ? " — captions not downloaded, answers will use title and description only."
                : "."}
            </p>
          )}
        {messages.map((m) => {
          const waiting =
            sending && m.role === "assistant" && !m.content.trim();
          const costLabel =
            showCosts &&
            m.role === "assistant" &&
            typeof m.cost === "number" &&
            m.cost >= 0
              ? formatUsdCost(m.cost)
              : "";
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
                    ? "w-fit max-w-[70%] rounded-lg bg-accent/10 px-3 py-2 text-sm text-gray-200"
                    : "relative w-fit max-w-[90%] rounded-lg bg-ink-950/80 px-3 py-2 text-sm text-gray-300"
                }
              >
                <div className="mb-0.5 flex items-center justify-between gap-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                    {m.role === "user" ? "You" : "Video"}
                  </p>
                  {costLabel && (
                    <span
                      className="text-[10px] tabular-nums text-gray-600"
                      title="OpenRouter cost for this reply"
                      aria-label={`Reply cost ${costLabel}`}
                    >
                      {costLabel}
                    </span>
                  )}
                </div>
                {waiting ? (
                  <TypingDots label="Video is typing" className="py-1" />
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
              </div>
            </div>
          );
        })}
        {error && <p className="text-xs text-amber-400/90">{error}</p>}
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
            placeholder="Ask this video…"
            className="horde-scrollbar min-h-[2.5rem] flex-1 resize-none rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-accent focus:outline-none"
          />
          {sending ? (
            <button
              type="button"
              onClick={cancel}
              className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-amber-500/50 hover:text-amber-300"
            >
              Cancel
            </button>
          ) : (
            <>
              {messages.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearThread()}
                  className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent"
                >
                  Clear
                </button>
              )}
              <button
                type="submit"
                disabled={!draft.trim()}
                className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
