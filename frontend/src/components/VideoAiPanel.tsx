import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobile } from "../hooks/useIsMobile";
import {
  clampPanelHeight,
  panelHeightRange,
  usePanelSize,
} from "../hooks/usePanelSize";
import { useSettings } from "../hooks/useSettings";
import AiMarkdown from "./AiMarkdown";
import Collapse from "./Collapse";
import OverlayScrollThumb from "./OverlayScrollThumb";
import ResizeHandle from "./ResizeHandle";
import TypingDots from "./TypingDots";
import type { AiTarget } from "./aiTarget";
import VideoAiChat from "./VideoAiChat";

type AiTab = "summary" | "chat";

/** Smallest height the summary can be dragged to, in rem. */
const MIN_SUMMARY_REM = 4;

interface Props {
  target: AiTarget;
  canSummarize: boolean;
  canChat: boolean;
  showCosts?: boolean;
  showToast: (msg: string) => void;
}

export default function VideoAiPanel({
  target,
  canSummarize,
  canChat,
  showCosts = false,
  showToast,
}: Props) {
  const [settings, updateSettings] = useSettings();
  const [tab, setTab] = useState<AiTab>("summary");
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summarizeAbortRef = useRef<AbortController | null>(null);
  const summaryScrollRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [summaryHeight, setSummaryHeight, commitSummaryHeight] =
    usePanelSize("aiSummary");
  // A dragged height is fixed (not a cap), so the handle always follows the
  // pointer, even past the end of a short summary.
  const summaryFixed =
    !isMobile && summaryHeight != null ? summaryHeight : null;

  const expanded = settings.aiExpanded;
  const showToggle = canSummarize && canChat;
  const activeTab: AiTab = showToggle ? tab : canSummarize ? "summary" : "chat";

  useEffect(() => {
    setSummaryError(null);
    summarizeAbortRef.current?.abort();
    summarizeAbortRef.current = null;
    setSummarizing(false);
    setTab("summary");
  }, [target.key]);

  useEffect(() => {
    return () => {
      summarizeAbortRef.current?.abort();
    };
  }, []);

  const summaryText = target.summary ?? "";
  const hasAiSummary = !!summaryText.trim();
  const waitingOnSummary =
    summarizing || (target.processingSummary && !hasAiSummary);
  const { summarize } = target;

  const runSummarize = useCallback(
    async (force: boolean) => {
      if (!canSummarize) return;
      if (!force && hasAiSummary) {
        updateSettings({ aiExpanded: true });
        setSummaryError(null);
        return;
      }
      setSummarizing(true);
      updateSettings({ aiExpanded: true });
      setTab("summary");
      setSummaryError(null);
      const ac = new AbortController();
      summarizeAbortRef.current = ac;
      try {
        await summarize(force, ac.signal);
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
    [canSummarize, hasAiSummary, summarize, showToast, updateSettings]
  );

  if (!canSummarize && !canChat) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        <button
          type="button"
          onClick={() => updateSettings({ aiExpanded: !expanded })}
          className="ui-panel-toggle ui-interactive flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
        >
          <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
            <span>AI</span>
            <span>{expanded ? "▲" : "▼"}</span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
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
          {expanded && showToggle && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setTab("summary")}
                className={
                  activeTab === "summary"
                    ? "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent"
                    : "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted hover:text-gray-400"
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
                    : "px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted hover:text-gray-400"
                }
              >
                Chat
              </button>
            </div>
          )}
        </div>
      </div>

      <Collapse open={expanded}>
        <div>
          {activeTab === "summary" && canSummarize && (
            <div className="ui-panel group relative isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
              <div
                ref={summaryScrollRef}
                className={
                  summaryFixed != null
                    ? "horde-meta-scrollbar overflow-y-auto"
                    : undefined
                }
                style={
                  summaryFixed != null ? { height: summaryFixed } : undefined
                }
              >
                <div className="px-4 py-3">
                  {summaryError && (
                    <p className="mb-2 text-xs text-amber-400/90">
                      {summaryError}
                    </p>
                  )}
                  {hasAiSummary ? (
                    <AiMarkdown text={summaryText} />
                  ) : waitingOnSummary ? (
                    <div className="flex justify-center py-8">
                      <TypingDots label="Generating summary" />
                    </div>
                  ) : (
                    <div className="flex flex-col items-start gap-3 py-2">
                      <p className="text-xs text-muted">
                        No summary yet. Summaries are generated from captions
                        and video metadata.
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
              {summaryFixed != null && (
                <OverlayScrollThumb
                  scrollRef={summaryScrollRef}
                  revision={`${summaryFixed}-${summaryText.length}`}
                />
              )}
              {!isMobile && (
                <ResizeHandle
                  axis="y"
                  label="Resize summary"
                  className="absolute inset-x-0 bottom-0 h-2.5"
                  getStart={() =>
                    summaryScrollRef.current?.getBoundingClientRect().height ??
                    0
                  }
                  toValue={(start, delta) =>
                    clampPanelHeight(start + delta, MIN_SUMMARY_REM)
                  }
                  onChange={setSummaryHeight}
                  onCommit={commitSummaryHeight}
                  onReset={() => commitSummaryHeight(null)}
                  {...panelHeightRange(MIN_SUMMARY_REM)}
                />
              )}
            </div>
          )}

          {canChat && (
            <VideoAiChat
              chatKey={target.key}
              chat={target.chat}
              summary={target.summary}
              hasSubtitles={target.hasSubtitles}
              active={activeTab === "chat"}
              showCosts={showCosts}
              showToast={showToast}
            />
          )}
          {target.note && (
            <p className="mt-2 text-xs text-muted">{target.note}</p>
          )}
        </div>
      </Collapse>
    </div>
  );
}
