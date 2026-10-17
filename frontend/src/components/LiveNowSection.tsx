import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../hooks/useSettings";
import { useLiveNow } from "../queries/follows";
import { formatViewers } from "../utils/followUrl";
import { joinDotList } from "../utils";

const VISIBLE_ROWS = 5;

/**
 * Followed channels that are live, in the library sidebar. Renders nothing
 * unless the setting is on and at least one stream is live.
 */
export default function LiveNowSection() {
  const [settings] = useSettings();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { live } = useLiveNow({ enabled: settings.showLiveStreams });
  if (!settings.showLiveStreams || live.length === 0) return null;
  const rows = expanded ? live : live.slice(0, VISIBLE_ROWS);
  return (
    <section aria-label="Live now" className="mb-2" data-horde="live-now">
      <h3 className="flex items-center gap-1.5 px-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">
        <span
          aria-hidden="true"
          className="inline-block h-1.5 w-1.5 rounded-full bg-red-500/80"
        />
        Live
        <span className="font-normal normal-case">{live.length}</span>
      </h3>
      <ul className="space-y-0.5">
        {rows.map((item) => {
          const sub = joinDotList([
            item.title,
            item.game,
            formatViewers(item.viewers),
          ]);
          return (
            <li key={item.video_id}>
              <button
                type="button"
                title={[item.title, item.game].filter(Boolean).join(" · ")}
                onClick={() =>
                  navigate(
                    `/watch?url=${encodeURIComponent(item.watch_url)}&channel=${encodeURIComponent(item.channel_name ?? "")}`
                  )
                }
                className="w-full min-w-0 rounded-lg px-3 py-1 text-left hover:bg-ink-800"
              >
                <span className="block truncate text-sm text-gray-300">
                  {item.channel_name ?? item.channel_url}
                </span>
                {sub && (
                  <span className="block truncate text-xs text-muted">
                    {sub}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {live.length > VISIBLE_ROWS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full rounded-lg px-3 py-1 text-left text-xs text-muted hover:bg-ink-800 hover:text-gray-300"
        >
          {expanded ? "Show less" : `Show all (${live.length})`}
        </button>
      )}
    </section>
  );
}
