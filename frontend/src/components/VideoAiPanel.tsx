import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useSettings } from "../hooks/useSettings";
import type { Video } from "../types";
import Collapse from "./Collapse";
import TypingDots from "./TypingDots";
import VideoAiChat from "./VideoAiChat";

type AiTab = "summary" | "chat";

interface Props {
  video: Video;
  canSummarize: boolean;
  canChat: boolean;
  onVideoUpdate: (video: Video) => void;
  showToast: (msg: string) => void;
}

export default function VideoAiPanel({
  video,
  canSummarize,
  canChat,
  onVideoUpdate,
  showToast,
}: Props) {
  const [settings, updateSettings] = useSettings();
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summarizeAbortRef = useRef<AbortController | null>(null);

  const expanded = settings.aiExpanded;
  const showToggle = canSummarize && canChat;
  const preferredTab: AiTab =
    settings.aiTab === "chat" && canChat
      ? "chat"
      : canSummarize
        ? "summary"
        : "chat";
  const activeTab: AiTab = showToggle
    ? preferredTab
    : canSummarize
      ? "summary"
      : "chat";

  useEffect(() => {
    setSummaryError(null);
    summarizeAbortRef.current?.abort();
    summarizeAbortRef.current = null;
    setSummarizing(false);
  }, [video.id]);

  useEffect(() => {
    return () => {
      summarizeAbortRef.current?.abort();
    };
  }, []);

  const hasAiSummary = !!(video.ai_summary && video.ai_summary.trim());

  function setTab(next: AiTab) {
    if (next === settings.aiTab) return;
    updateSettings({ aiTab: next });
  }

  const runSummarize = useCallback(
    async (force: boolean) => {
      if (!canSummarize) return;
      if (!force && hasAiSummary) {
        updateSettings({ aiExpanded: true, aiTab: "summary" });
        setSummaryError(null);
        return;
      }
      setSummarizing(true);
      updateSettings({ aiExpanded: true, aiTab: "summary" });
      setSummaryError(null);
      const ac = new AbortController();
      summarizeAbortRef.current = ac;
      try {
        const updated = await api.summarizeVideo(video.id, {
          force,
          signal: ac.signal,
        });
        onVideoUpdate(updated);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const msg =
          err instanceof Error ? err.message : "Could not generate summary";
        setSummaryError(msg);
        showToast(msg);
      } finally {
        if (summarizeAbortRef.current === ac) {
          summarizeAbortRef.current = null;
        }
        setSummarizing(false);
      }
    },
    [
      canSummarize,
      hasAiSummary,
      video.id,
      onVideoUpdate,
      showToast,
      updateSettings,
    ]
  );

  if (!canSummarize && !canChat) return null;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 py-2">
        <button
          type="button"
          onClick={() => updateSettings({ aiExpanded: !expanded })}
          className="ui-panel-toggle ui-interactive flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
        >
          <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
            <span>AI</span>
            <span>{expanded ? "▲" : "▼"}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {expanded && showToggle && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setTab("summary")}
                className={
                  activeTab === "summary"
                    ? "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                    : "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600 hover:text-gray-400"
                }
              >
                Summary
              </button>
              <span className="text-[10px] text-gray-700" aria-hidden>
                /
              </span>
              <button
                type="button"
                onClick={() => setTab("chat")}
                className={
                  activeTab === "chat"
                    ? "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                    : "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-600 hover:text-gray-400"
                }
              >
                Chat
              </button>
            </div>
          )}
          {activeTab === "summary" &&
            expanded &&
            (summarizing ? (
              <button
                type="button"
                onClick={() => {
                  summarizeAbortRef.current?.abort();
                  summarizeAbortRef.current = null;
                  setSummarizing(false);
                  setSummaryError(null);
                  showToast("Summary cancelled");
                }}
                className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-amber-500/50 hover:text-amber-300"
              >
                Cancel
              </button>
            ) : (
              (hasAiSummary || !!summaryError) && (
                <button
                  type="button"
                  onClick={() => void runSummarize(true)}
                  className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
                >
                  Regenerate
                </button>
              )
            ))}
        </div>
      </div>

      <Collapse open={expanded}>
        <div>
          {activeTab === "summary" && canSummarize && (
            <div className="ui-panel isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
              <div className="px-4 py-3">
                {summaryError && (
                  <p className="mb-2 text-xs text-amber-400/90">{summaryError}</p>
                )}
                {hasAiSummary ? (
                  <div className="space-y-3 text-sm text-gray-300">
                    {(video.ai_summary || "")
                      .trim()
                      .split(/\n\s*\n+/)
                      .map((p) => p.replace(/\n+/g, " ").trim())
                      .filter(Boolean)
                      .map((para, i, paras) => {
                        const isLast = i === paras.length - 1;
                        const showLen =
                          isLast &&
                          !!video.ai_summary_length &&
                          ["short", "medium", "long"].includes(
                            video.ai_summary_length
                          );
                        return (
                          <p
                            key={i}
                            className={showLen ? "relative pr-12" : undefined}
                          >
                            {para}
                            {showLen && (
                              <span
                                className="absolute bottom-0 right-0 text-[10px] font-medium uppercase tracking-wider text-gray-500/70"
                                aria-label={`Summary length: ${video.ai_summary_length}`}
                              >
                                {video.ai_summary_length}
                              </span>
                            )}
                          </p>
                        );
                      })}
                  </div>
                ) : summarizing ? (
                  <div className="flex justify-center py-8">
                    <TypingDots label="Generating summary" />
                  </div>
                ) : (
                  <div className="flex flex-col items-start gap-3 py-2">
                    <p className="text-xs text-gray-500">
                      No summary yet. Summaries are generated from captions and
                      video metadata.
                    </p>
                    <button
                      type="button"
                      onClick={() => void runSummarize(false)}
                      className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-xs font-medium text-gray-300 hover:border-accent hover:text-accent"
                    >
                      Generate summary
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {canChat && (
            <VideoAiChat
              videoId={video.id}
              summary={video.ai_summary}
              hasSubtitles={(video.subtitles?.length ?? 0) > 0}
              active={activeTab === "chat"}
              showToast={showToast}
            />
          )}
        </div>
      </Collapse>
    </div>
  );
}
