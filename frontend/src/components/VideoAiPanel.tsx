import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useHelpChat } from "../context/HelpChatContext";
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
import { ChevronIcon, ExternalIcon } from "./icons";

/** Smallest height the summary can be dragged to, in rem. */
const MIN_SUMMARY_REM = 4;

interface Props {
  target: AiTarget;
  canSummarize: boolean;
  canChat: boolean;
  showToast: (msg: string) => void;
}

/**
 * The watch page's Summary section: the AI summary (generate, regenerate,
 * resize), and "Chat", which opens Ask on this video.
 */
export default function VideoAiPanel({
  target,
  canSummarize,
  canChat,
  showToast,
}: Props) {
  const [settings, updateSettings] = useSettings();
  const help = useHelpChat();
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summarizeAbortRef = useRef<AbortController | null>(null);
  const summaryScrollRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [summaryHeight, setSummaryHeight, commitSummaryHeight] =
    usePanelSize("aiSummary");

  const expanded = settings.aiExpanded;
  const showChat = canChat && help.available;

  useEffect(() => {
    setSummaryError(null);
    summarizeAbortRef.current?.abort();
    summarizeAbortRef.current = null;
    setSummarizing(false);
  }, [target.key]);

  useEffect(() => {
    return () => {
      summarizeAbortRef.current?.abort();
    };
  }, []);

  const summaryText = target.summary ?? "";
  const hasAiSummary = !!summaryText.trim();
  // A saved summary shows even when it cannot be generated again (summaries
  // switched off, captions gone); generating needs `canSummarize`.
  const showSummary = canSummarize || hasAiSummary;
  const waitingOnSummary =
    summarizing || (target.processingSummary && !hasAiSummary);
  const { summarize } = target;

  // The summary may be dragged shorter (to scroll it) but never taller than
  // its own text, which would leave an empty box. Measured from the rendered
  // content because the text wraps differently at different widths.
  const summaryContentRef = useRef<HTMLDivElement>(null);
  const [summaryContentPx, setSummaryContentPx] = useState(0);
  // Measured before paint, so a saved height taller than the text never shows.
  useLayoutEffect(() => {
    if (!expanded || !showSummary) return;
    const el = summaryContentRef.current;
    if (!el) return;
    const measure = () => setSummaryContentPx(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    expanded,
    showSummary,
    isMobile,
    summaryText,
    summaryError,
    waitingOnSummary,
  ]);

  const summaryRange = panelHeightRange(MIN_SUMMARY_REM);
  const summaryMaxPx =
    summaryContentPx > 0
      ? Math.min(summaryRange.valueMax, summaryContentPx)
      : summaryRange.valueMax;
  // A dragged height is fixed (so scrolling stays put), capped at the content.
  const summaryFixed =
    !isMobile && summaryHeight != null
      ? Math.min(summaryHeight, summaryMaxPx)
      : null;

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

  if (!showSummary && !showChat) return null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
        {showSummary ? (
          <button
            type="button"
            onClick={() => updateSettings({ aiExpanded: !expanded })}
            className="ui-panel-toggle ui-interactive flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-accent"
          >
            <span className="ui-panel-toggle-press inline-flex items-center gap-2 transition-transform">
              <span>Summary</span>
              <ChevronIcon
                className={`transition-transform duration-200 ease-fluid ${expanded ? "rotate-180" : ""}`}
              />
            </span>
          </button>
        ) : (
          <span className="flex-1" />
        )}
        <div className="flex shrink-0 items-center gap-2">
          {canSummarize &&
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
                className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-warning/50 hover:text-warning"
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
          {showChat && (
            <button
              type="button"
              onClick={() => help.askVideo(target.askVideo)}
              title="Ask about this video"
              className="ui-panel ui-interactive inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-accent hover:text-accent"
            >
              Chat
              <ExternalIcon className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <Collapse open={expanded && showSummary}>
        <div>
          {showSummary && (
            <div className="ui-panel group relative isolate min-h-0 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 ring-1 ring-ink-700">
              <div
                ref={summaryScrollRef}
                data-horde="ai-summary-body"
                className={
                  summaryFixed != null
                    ? "horde-meta-scrollbar overflow-y-auto"
                    : undefined
                }
                style={
                  summaryFixed != null ? { height: summaryFixed } : undefined
                }
              >
                <div
                  ref={summaryContentRef}
                  data-horde="ai-summary-content"
                  className="px-4 py-3"
                >
                  {summaryError && (
                    <p className="mb-2 text-xs text-warning">{summaryError}</p>
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
                    // Never taller than the text: the box would be empty.
                    Math.min(
                      summaryMaxPx,
                      clampPanelHeight(start + delta, MIN_SUMMARY_REM)
                    )
                  }
                  onChange={setSummaryHeight}
                  onCommit={commitSummaryHeight}
                  onReset={() => commitSummaryHeight(null)}
                  valueMin={summaryRange.valueMin}
                  valueMax={Math.max(summaryRange.valueMin, summaryMaxPx)}
                />
              )}
            </div>
          )}

        </div>
      </Collapse>
    </div>
  );
}
