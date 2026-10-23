import type { DeviceSession } from "../../types";
import { formatDate, formatRelative } from "../../utils";
import { PANEL_BTN } from "../settings/constants";

/** "Active 5m ago" while recent, otherwise the day it was last seen. */
function activity(s: DeviceSession): string {
  const ago = formatRelative(s.last_seen_at);
  if (ago === "just now") return "Active just now";
  if (/^\d+[mh] ago$/.test(ago)) return `Active ${ago}`;
  return `Last active ${formatDate(s.last_seen_at)}`;
}

/** The signed-in browsers of one account, each with its own Sign out. */
export default function SessionRows({
  sessions,
  busy,
  onSignOut,
}: {
  sessions: DeviceSession[];
  busy: boolean;
  onSignOut: (s: DeviceSession) => void;
}) {
  return (
    <ul
      data-horde="session-list"
      className="divide-y divide-ink-700 rounded-lg border border-ink-700"
    >
      {sessions.map((s) => (
        <li
          key={s.id}
          data-horde="session-row"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-gray-100">{s.device}</span>
              {s.current && (
                <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-xs text-accent">
                  This device
                </span>
              )}
            </div>
            <p className="text-xs text-muted">
              {[s.ip, activity(s), `Signed in ${formatDate(s.created_at)}`]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <button
            type="button"
            className={PANEL_BTN}
            disabled={busy}
            aria-label={`Sign out ${s.device}${s.ip ? ` (${s.ip})` : ""}`}
            onClick={() => onSignOut(s)}
          >
            Sign out
          </button>
        </li>
      ))}
    </ul>
  );
}
