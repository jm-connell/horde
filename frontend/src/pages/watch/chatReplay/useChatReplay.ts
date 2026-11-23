import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api } from "../../../api";
import { queryKeys } from "../../../queries/keys";
import type { ChatReplayItem, ChatReplayPage } from "../../../types";
import {
  type Loaded,
  mergeChunk,
  needsNext,
  needsReload,
  trimBehind,
  visibleItems,
} from "./model";

/** How often the playback position is read. */
const TICK_MS = 250;
/** Jumps this close share a cached page (the server buckets the same way). */
const AT_BUCKET_MS = 5_000;
/** Pages stay readable from the cache as long as the server keeps them. */
const GC_MS = 30 * 60_000;

export type ChatReplayStatus =
  "idle" | "loading" | "ok" | "none" | "unavailable" | "error";

export type ChatReplayState = {
  status: ChatReplayStatus;
  /** The messages up to the playback position, newest last. */
  items: ChatReplayItem[];
  /** The error envelope's code when `status` is `error`. */
  errorCode: string | null;
  retry: () => void;
};

/**
 * A past stream's chat replay, following the playback position: reads the
 * stretch at the position, the next stretch before it runs out, and afresh
 * after a seek outside what is loaded. One request at a time; an error stops
 * reading until `retry`. Pass `null` to stop (hidden, or no chat for the video).
 */
export function useChatReplay(
  youtubeId: string | null,
  getPositionSec: () => number
): ChatReplayState {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ChatReplayStatus>("idle");
  const [items, setItems] = useState<ChatReplayItem[]>([]);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const getPosition = useRef(getPositionSec);
  // The video the state below was read for.
  const stateFor = useRef<string | null>(null);

  useEffect(() => {
    getPosition.current = getPositionSec;
  }, [getPositionSec]);

  useEffect(() => {
    stateFor.current = youtubeId;
    setItems([]);
    setErrorCode(null);
    if (!youtubeId) {
      setStatus("idle");
      return;
    }
    setStatus("loading");
    let cancelled = false;
    let stopped = false;
    let loaded: Loaded | null = null;
    let inFlight = false;
    // Bumped by a fresh read: an older request's answer is then ignored.
    let generation = 0;
    let shownKey = "";

    const positionMs = () => Math.max(0, getPosition.current() * 1000);

    const show = () => {
      const shown = visibleItems(loaded, positionMs());
      const key = shown.length
        ? `${shown[0].id}|${shown[shown.length - 1].id}|${shown.length}`
        : "";
      if (key !== shownKey) {
        shownKey = key;
        setItems(shown);
      }
    };

    const read = (atMs: number | null, cursor: string | null) => {
      const mine = generation;
      inFlight = true;
      const page: Promise<ChatReplayPage> =
        cursor !== null
          ? queryClient.fetchQuery({
              queryKey: queryKeys.chatReplay.next(youtubeId, cursor),
              queryFn: ({ signal }) =>
                api.chatReplayNext(youtubeId, cursor, { signal }),
              staleTime: Infinity,
              gcTime: GC_MS,
              retry: false,
            })
          : queryClient.fetchQuery({
              queryKey: queryKeys.chatReplay.at(
                youtubeId,
                Math.floor((atMs ?? 0) / AT_BUCKET_MS)
              ),
              queryFn: ({ signal }) =>
                api.chatReplayAt(youtubeId, atMs ?? 0, { signal }),
              staleTime: Infinity,
              gcTime: GC_MS,
              retry: false,
            });
      page.then(
        (result) => {
          if (cancelled || mine !== generation) return;
          inFlight = false;
          if (result.status !== "ok") {
            stopped = true;
            loaded = null;
            show();
            setStatus(result.status);
            return;
          }
          loaded = trimBehind(
            mergeChunk(loaded, result, cursor === null ? atMs : null),
            positionMs()
          );
          setStatus("ok");
          show();
        },
        (error: unknown) => {
          if (cancelled || mine !== generation) return;
          inFlight = false;
          stopped = true;
          setErrorCode(error instanceof ApiError ? (error.code ?? null) : null);
          setStatus("error");
        }
      );
    };

    const tick = () => {
      if (cancelled || stopped) return;
      const at = positionMs();
      if (loaded === null) {
        if (!inFlight) read(at, null);
      } else if (needsReload(loaded, at)) {
        // A seek outside what is loaded: clear the list and read from there.
        generation += 1;
        loaded = null;
        show();
        read(at, null);
      } else if (!inFlight && needsNext(loaded, at) && loaded.nextCursor) {
        read(null, loaded.nextCursor);
      }
      show();
    };

    tick();
    const timer = window.setInterval(tick, TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [youtubeId, attempt, queryClient]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // State belongs to the video it was read for: right after a switch, before
  // the effect has reset it, the previous video's messages are not shown.
  if (stateFor.current !== youtubeId) {
    return {
      status: youtubeId ? "loading" : "idle",
      items: [],
      errorCode: null,
      retry,
    };
  }
  return { status, items, errorCode, retry };
}
