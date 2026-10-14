import { useEffect, useRef, useState } from "react";
import { connectivity } from "../offline/connectivity";
import { useConnectivity } from "../offline/hooks";

/**
 * Header status pill. Hidden while the connection is healthy.
 * - Connecting… (boot / reconnect), with a "Go offline" offer after 5s
 * - Slow connection · Go offline
 * - Offline (tap to reconnect; auto-retries in the background unless the
 *   user chose offline mode)
 */
export default function ConnectionTag({ floating = false }: { floating?: boolean }) {
  const state = useConnectivity();
  const [stillOffline, setStillOffline] = useState(false);
  const stillTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (stillTimer.current) window.clearTimeout(stillTimer.current);
    },
    [],
  );

  if (state.status === "online") return null;

  const reconnect = async () => {
    await connectivity.reconnect();
    if (connectivity.offlineMode) {
      setStillOffline(true);
      if (stillTimer.current) window.clearTimeout(stillTimer.current);
      stillTimer.current = window.setTimeout(() => setStillOffline(false), 2500);
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
    return (
      <button
        type="button"
        data-horde="connection-tag"
        data-status="offline"
        onClick={() => void reconnect()}
        disabled={busy}
        title={
          state.manual
            ? "Offline mode — tap to reconnect"
            : "Can't reach the server — retrying automatically. Tap to retry now."
        }
        aria-live="polite"
        className={`${wrap} ui-interactive border-gray-600 bg-ink-800 text-gray-200 hover:bg-ink-700`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${busy ? "animate-pulse bg-amber-400" : "bg-gray-400"}`}
        />
        {busy ? "Reconnecting…" : stillOffline ? "Still offline" : "Offline"}
        {!busy && !stillOffline && (
          <span className="hidden text-gray-400 sm:inline">· Reconnect</span>
        )}
      </button>
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
