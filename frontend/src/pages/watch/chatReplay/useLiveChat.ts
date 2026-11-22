import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../../api";
import type { ChatReplayItem } from "../../../types";
import { mergeLive, needsLiveReset, unavailableNote } from "./liveModel";
import type { ChatReplayState, ChatReplayStatus } from "./useChatReplay";

/** How often the server's buffer is read. */
const TICK_MS = 2_000;

export type LiveChatState = ChatReplayState & {
  /** "Chat from before HH:MM isn't available." when the viewer is that early. */
  note: string | null;
};

/**
 * A live broadcast's chat at the moment being watched: every 2 s, read what
 * the server holds up to `getBehindLiveSec()` behind the live edge, after the
 * last message read; a scrub back reads afresh from that moment. One request
 * at a time; an error stops reading until `retry`. `null` stops.
 */
export function useLiveChat(
  videoId: string | null,
  getBehindLiveSec: () => number | null
): LiveChatState {
  const [status, setStatus] = useState<ChatReplayStatus>("idle");
  const [items, setItems] = useState<ChatReplayItem[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const getBehind = useRef(getBehindLiveSec);
  // The video the state below was read for.
  const stateFor = useRef<string | null>(null);

  useEffect(() => {
    getBehind.current = getBehindLiveSec;
  }, [getBehindLiveSec]);

  useEffect(() => {
    stateFor.current = videoId;
    setItems([]);
    setNote(null);
    setErrorCode(null);
    if (!videoId) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    let inFlight = false;
    let after = 0;
    let previousBehindMs: number | null = null;
    let list: ChatReplayItem[] = [];
    const controller = new AbortController();

    const tick = () => {
      if (cancelled || inFlight) return;
      const behindMs = Math.max(0, (getBehind.current() ?? 0) * 1000);
      const reset = needsLiveReset(previousBehindMs, behindMs);
      if (reset) after = 0;
      previousBehindMs = behindMs;
      inFlight = true;
      api
        .liveChat(videoId, behindMs, after, { signal: controller.signal })
        .then(
          (page) => {
            if (cancelled) return;
            inFlight = false;
            if (page.status !== "ok") {
              cancelled = true;
              window.clearInterval(timer);
              setStatus(page.status);
              return;
            }
            list = mergeLive(list, page, reset || after === 0);
            after = page.next_after ?? after;
            setItems(list);
            setNote(unavailableNote(page.earliest_ms, page.cutoff_ms));
            setStatus("ok");
          },
          (error: unknown) => {
            if (cancelled) return;
            inFlight = false;
            cancelled = true;
            window.clearInterval(timer);
            setErrorCode(
              error instanceof ApiError ? (error.code ?? null) : null
            );
            setStatus("error");
          }
        );
    };

    const timer = window.setInterval(tick, TICK_MS);
    tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      controller.abort();
    };
  }, [videoId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  if (stateFor.current !== videoId) {
    return {
      status: videoId ? "loading" : "idle",
      items: [],
      errorCode: null,
      note: null,
      retry,
    };
  }
  return { status, items, errorCode, note, retry };
}
