import { useEffect, useRef, useState } from "react";
import { connectivity } from "../offline/connectivity";
import { useConnectivity } from "../offline/hooks";

/**
 * Header status pill. Hidden while the connection is healthy.
 * - Connecting… (boot / reconnect), with a "Go offline" offer after 5s
 * - Slow connection · Go offline
 * - Offline: a subtle label (tap to reconnect; auto-retries in the background
 *   unless the user turned on offline mode in Settings)
 */
export default function ConnectionTag({
  floating = false,
  popupAlign = "center",
}: {
  floating?: boolean;
  /** "end" right-aligns the failure popup (pill at the right edge). */
  popupAlign?: "center" | "end";
}) {
  const state = useConnectivity();
  const [failed, setFailed] = useState(false);
  const failedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (failedTimer.current) window.clearTimeout(failedTimer.current);
    },
    [],
  );

  if (state.status === "online") return null;

  // Tapping the offline pill turns the offline mode setting off and tries the
  // server; on failure a brief popup says so and the pill reads Offline again.
  const reconnect = async () => {
    if (failedTimer.current) window.clearTimeout(failedTimer.current);
    setFailed(false);
    await connectivity.reconnect();
    if (connectivity.offlineMode) {
      setFailed(true);
      failedTimer.current = window.setTimeout(() => setFailed(false), 3000);
    }
  };

  const wrap = `ui-panel flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${
    floating ? "fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-50 -translate-x-1/2 shadow-xl" : ""
  }`;

  const offerBtn = (
    <button
      type="button"
      onClick={() => connectivity.goOffline()}
      className="ui-interactive -my-0.5 rounded-full bg-ink-700 px-2 py-0.5 text-gray-100 hover:bg-ink-600"
    >
      Go offline
    </button>
  );

  if (state.status === "offline") {
    const busy = state.reconnecting;
    // Subtle label; turned off in Settings → Playback or by tapping it.
    return (
      <span
        className={`relative flex shrink-0 ${
          floating
            ? "fixed left-1/2 top-[calc(env(safe-area-inset-top)+0.75rem)] z-50 -translate-x-1/2"
            : ""
        }`}
      >
        <button
          type="button"
          data-horde="connection-tag"
          data-status={busy ? "connecting" : "offline"}
          onClick={() => void reconnect()}
          disabled={busy}
          title={
            state.manual
              ? "Offline mode is on — tap to reconnect"
              : "Can't reach the server — retrying automatically. Tap to retry now."
          }
          aria-live="polite"
          className={`ui-interactive flex items-center gap-1.5 rounded-full border border-gray-600/60 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide whitespace-nowrap text-gray-400 hover:text-gray-200 ${
            floating ? "ui-panel shadow-xl" : "bg-transparent"
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-gray-500"}`}
          />
          {busy ? "Connecting…" : "Offline"}
        </button>
        {failed && !busy && (
          <span
            role="status"
            data-horde="connection-failed"
            className={`ui-panel pointer-events-none absolute top-full z-50 mt-1.5 ${
              popupAlign === "end" ? "right-0" : "left-1/2 -translate-x-1/2"
            } animate-[page-fade-in_200ms_ease-out] whitespace-nowrap rounded-md border border-gray-700 px-2 py-1 text-[11px] text-gray-300 shadow-lg`}
          >
            Couldn't connect to the server
          </span>
        )}
      </span>
    );
  }

  const slow = state.status === "slow";
  return (
    <div
      data-horde="connection-tag"
      data-status={state.status}
      role="status"
      aria-live="polite"
      className={`${wrap} border-amber-500/40 bg-amber-500/10 text-amber-200`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full bg-amber-400 ${slow ? "" : "animate-pulse"}`}
      />
      {/* Phones: once the offer shows, the button carries the message. */}
      <span className={state.offerOffline && !floating ? "hidden sm:inline" : ""}>
        {slow ? "Slow connection" : "Connecting…"}
      </span>
      {state.offerOffline && offerBtn}
    </div>
  );
}
