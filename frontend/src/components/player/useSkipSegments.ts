import {
  useCallback,
  useReducer,
  useRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { SponsorSegment } from "../../hooks/useSponsorBlock";
import {
  sponsorBlockSegmentLabel,
  type SponsorBlockSkipMode,
} from "../../sponsorBlock";
import {
  sponsorSegmentKey,
  suppressSponsorSegmentsOnBackwardSeek,
} from "../videoPlayerSponsor";

export interface SkippedSegment {
  startSec: number;
  endSec: number;
  label: string;
}

/** What the SponsorBlock notice is showing: a Skip prompt or a Go back chip. */
export type SkipNotice =
  | { kind: "prompt"; segment: SkippedSegment }
  | { kind: "skipped"; segment: SkippedSegment };

type NoticeAction =
  | { type: "prompt"; segment: SkippedSegment }
  | { type: "skipped"; segment: SkippedSegment }
  | { type: "clear" };

function noticeReducer(
  _state: SkipNotice | null,
  action: NoticeAction
): SkipNotice | null {
  switch (action.type) {
    case "prompt":
      return { kind: "prompt", segment: action.segment };
    case "skipped":
      return { kind: "skipped", segment: action.segment };
    case "clear":
      return null;
  }
}

/** Text of the notice chip, derived from what it is showing. */
export function skipNoticeText(notice: SkipNotice): string {
  return notice.kind === "skipped"
    ? `Skipped: ${notice.segment.label}`
    : notice.segment.label;
}

interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Playhead at the previous timeupdate; owned by the player, shared with seeks. */
  prevTimeRef: MutableRefObject<number>;
  isSeekingRef: RefObject<boolean>;
  sponsorSegments: SponsorSegment[];
  sponsorSkipMode: SponsorBlockSkipMode;
  sponsorShowNotice: boolean;
}

const SKIPPED_NOTICE_MS = 4000;

/**
 * SponsorBlock playback: skips (or offers to skip) segments as the playhead
 * enters them, remembers segments the viewer seeked back into, and owns the
 * notice chip with its Skip / Go back actions.
 */
export function useSkipSegments({
  videoRef,
  prevTimeRef,
  isSeekingRef,
  sponsorSegments,
  sponsorSkipMode,
  sponsorShowNotice,
}: Options) {
  const [notice, dispatch] = useReducer(noticeReducer, null);
  const noticeTimer = useRef<number | null>(null);
  // Mirrors `notice.kind` so the timeupdate handler sees changes made earlier
  // in the same tick.
  const noticeKindRef = useRef<SkipNotice["kind"] | null>(null);
  const promptKeyRef = useRef<string | null>(null);
  const suppressedSegmentsRef = useRef(new Set<string>());
  const sponsorSegmentsRef = useRef(sponsorSegments);
  sponsorSegmentsRef.current = sponsorSegments;
  const sponsorSkipModeRef = useRef(sponsorSkipMode);
  sponsorSkipModeRef.current = sponsorSkipMode;

  const clearNoticeTimer = useCallback(() => {
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
      noticeTimer.current = null;
    }
  }, []);

  const clearNotice = useCallback(() => {
    promptKeyRef.current = null;
    noticeKindRef.current = null;
    dispatch({ type: "clear" });
    clearNoticeTimer();
  }, [clearNoticeTimer]);

  const showSkippedNotice = useCallback(
    (segment: SkippedSegment, timed: boolean) => {
      promptKeyRef.current = null;
      noticeKindRef.current = "skipped";
      dispatch({ type: "skipped", segment });
      clearNoticeTimer();
      if (timed) {
        noticeTimer.current = window.setTimeout(() => {
          noticeKindRef.current = null;
          dispatch({ type: "clear" });
          noticeTimer.current = null;
        }, SKIPPED_NOTICE_MS);
      }
    },
    [clearNoticeTimer]
  );

  // Drop the notice without touching its timer (a prompt has none).
  const clearNoticeState = useCallback(() => {
    promptKeyRef.current = null;
    noticeKindRef.current = null;
    dispatch({ type: "clear" });
  }, []);

  /** Forget everything about the previous source. */
  const reset = useCallback(() => {
    suppressedSegmentsRef.current.clear();
    clearNoticeState();
  }, [clearNoticeState]);

  /** Go back from a "Skipped" notice and don't skip that segment again. */
  const undoSkip = useCallback(() => {
    const seg = notice?.segment;
    const v = videoRef.current;
    if (!seg || !v) return;
    suppressedSegmentsRef.current.add(sponsorSegmentKey(seg));
    v.currentTime = seg.startSec;
    clearNotice();
  }, [notice, videoRef, clearNotice]);

  /** Accept a skip prompt. */
  const skipPromptedSegment = useCallback(() => {
    const seg = notice?.segment;
    const v = videoRef.current;
    if (!seg || !v) return;
    v.currentTime = seg.endSec;
    prevTimeRef.current = seg.endSec;
    showSkippedNotice(seg, true);
  }, [notice, videoRef, prevTimeRef, showSkippedNotice]);

  /** A timeline / arrow seek from `from` to `to` (see `suppressSponsor...`). */
  const noteSeek = useCallback((from: number, to: number) => {
    // Timeline / arrow seeks set isSeeking and jump currentTime, so the
    // timeupdate "moving backward" check never sees the jump. Record it here.
    if (sponsorSkipModeRef.current !== "prompt") {
      suppressSponsorSegmentsOnBackwardSeek(
        from,
        to,
        sponsorSegmentsRef.current,
        suppressedSegmentsRef.current
      );
    }
  }, []);

  /** Run from the video's timeupdate with the new and previous playhead. */
  const handleTimeUpdate = useCallback(
    (video: HTMLVideoElement, t: number, prev: number) => {
      // SponsorBlock: auto-skip on forward playback; seeking back into a
      // segment suppresses it for the rest of this source.
      // Skip while a programmatic/user seek is in flight so distant
      // chapter jumps aren't redirected mid-seek.
      if (sponsorSegments.length === 0 || isSeekingRef.current) return;
      const movingForward = t >= prev - 0.05;
      const promptMode = sponsorSkipMode === "prompt";
      if (!promptMode) {
        suppressSponsorSegmentsOnBackwardSeek(
          prev,
          t,
          sponsorSegments,
          suppressedSegmentsRef.current
        );
      }
      let insidePrompt: SponsorSegment | null = null;
      for (const seg of sponsorSegments) {
        const key = sponsorSegmentKey(seg);
        if (suppressedSegmentsRef.current.has(key)) {
          continue;
        }
        if (movingForward && t >= seg.startSec && t < seg.endSec - 0.3) {
          if (promptMode) {
            insidePrompt = seg;
            break;
          }
          video.currentTime = seg.endSec;
          prevTimeRef.current = seg.endSec;
          if (sponsorShowNotice) {
            showSkippedNotice(
              {
                startSec: seg.startSec,
                endSec: seg.endSec,
                label: sponsorBlockSegmentLabel(seg.category),
              },
              true
            );
          }
          break;
        }
      }
      if (promptMode) {
        if (insidePrompt) {
          const key = `${insidePrompt.startSec}-${insidePrompt.endSec}`;
          if (promptKeyRef.current !== key) {
            promptKeyRef.current = key;
            clearNoticeTimer();
            noticeKindRef.current = "prompt";
            dispatch({
              type: "prompt",
              segment: {
                startSec: insidePrompt.startSec,
                endSec: insidePrompt.endSec,
                label: sponsorBlockSegmentLabel(insidePrompt.category),
              },
            });
          }
        } else if (noticeKindRef.current === "prompt") {
          clearNoticeState();
        }
      } else if (noticeKindRef.current === "prompt") {
        clearNoticeState();
      }
    },
    [
      sponsorSegments,
      sponsorSkipMode,
      sponsorShowNotice,
      isSeekingRef,
      prevTimeRef,
      showSkippedNotice,
      clearNoticeTimer,
      clearNoticeState,
    ]
  );

  return {
    notice,
    reset,
    noteSeek,
    undoSkip,
    skipPromptedSegment,
    handleTimeUpdate,
  };
}
