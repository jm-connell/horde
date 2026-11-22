import { useCallback, useEffect, type HTMLAttributes } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { streamWarmer } from "../queries/streamWarmup";
import { streamUrlFromHref } from "../utils/watchHref";

export type StreamWarmupHandlers = Pick<
  HTMLAttributes<HTMLElement>,
  "onPointerEnter" | "onPointerLeave" | "onPointerDown" | "onFocus" | "onBlur"
>;

/**
 * Handlers that warm a not-downloaded video when the mouse rests on its card
 * (or a mouse button goes down on it, or the keyboard focuses it), so the click
 * plays at once. Touch never warms: a touch also starts every scroll.
 *
 * Call once per component; the returned function gives each card its
 * handlers. A library link (`/watch/<id>`) gets none.
 */
export function useStreamWarmup(): (
  href: string | null
) => StreamWarmupHandlers {
  const client = useQueryClient();

  // A card that unmounts mid-dwell (scrolled away, page left) does not warm.
  useEffect(() => () => streamWarmer(client).leave(), [client]);

  return useCallback(
    (href: string | null): StreamWarmupHandlers => {
      const url = streamUrlFromHref(href);
      if (!url) return {};
      const warmer = streamWarmer(client);
      return {
        onPointerEnter: (e) => {
          if (e.pointerType === "mouse") warmer.rest(url);
        },
        onPointerLeave: () => warmer.leave(),
        onPointerDown: (e) => {
          if (e.pointerType === "mouse") warmer.warm(url);
        },
        onFocus: (e) => {
          if (
            e.target instanceof Element &&
            e.target.matches(":focus-visible")
          ) {
            warmer.rest(url);
          }
        },
        onBlur: () => warmer.leave(),
      };
    },
    [client]
  );
}
