import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import type { LiveChannel } from "../types";
import Collapse from "./Collapse";

const POLL_MS = 25_000;

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

export default function LiveChannelBar({
  enabled,
  expanded,
  onToggle,
  inset = null,
}: {
  enabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Theater-mode side inset, matching the nav row. */
  inset?: number | null;
}) {
  const [items, setItems] = useState<LiveChannel[]>([]);
  const navigate = useNavigate();
  const location = useLocation();
  const watching = new URLSearchParams(location.search).get("url");

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      return;
    }
    let active = true;
    const load = () => {
      api
        .listLiveChannels()
        .then((data) => {
          if (!active) return;
          setItems(data.enabled ? data.items : []);
        })
        .catch(() => {
          if (active) setItems([]);
        });
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [enabled]);

  if (!enabled || items.length === 0) return null;

  return (
    <div data-horde="live-channels" className="border-t border-ink-800">
      <div
        className={`mx-auto flex items-center gap-2 py-1 ${
          inset == null ? "max-w-[1920px] px-3 md:px-6" : "max-w-none"
        }`}
        style={
          inset != null
            ? { paddingLeft: inset, paddingRight: inset }
            : undefined
        }
      >
        <button
          type="button"
          onClick={onToggle}
          className="ui-interactive inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-xs font-medium text-gray-300 hover:text-gray-100"
          aria-expanded={expanded}
          aria-controls="live-channel-list"
        >
          <span
            className="h-1.5 w-1.5 rounded-full bg-red-500 motion-safe:animate-pulse"
            aria-hidden
          />
          Live
          <span className="tabular-nums text-gray-500">{items.length}</span>
        </button>
      </div>
      <Collapse open={expanded}>
        <div
          id="live-channel-list"
          className={`mx-auto flex gap-1.5 overflow-x-auto pb-1.5 ${
            inset == null ? "max-w-[1920px] px-3 md:px-6" : "max-w-none"
          }`}
          style={
            inset != null
              ? { paddingLeft: inset, paddingRight: inset }
              : undefined
          }
          role="group"
          aria-label="Channels live now"
        >
          {items.map((item) => {
            const active = watching === item.url;
            return (
              <button
                key={item.video_id}
                type="button"
                title={item.title ? `${item.channel} — ${item.title}` : item.channel}
                aria-label={
                  item.title
                    ? `${item.channel}, live: ${item.title}`
                    : `${item.channel}, live`
                }
                aria-current={active ? "true" : undefined}
                onClick={() =>
                  navigate(`/watch?url=${encodeURIComponent(item.url)}`)
                }
                className={`ui-interactive flex shrink-0 items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-xs ${
                  active
                    ? "border-accent/70 bg-accent/10 text-gray-100"
                    : "border-ink-700 bg-ink-900/80 text-gray-200 hover:border-ink-600"
                }`}
              >
                <span className="relative h-6 w-6 overflow-hidden rounded-full bg-ink-800">
                  {item.thumbnail_url ? (
                    <img
                      src={item.thumbnail_url}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-gray-300">
                      {initial(item.channel)}
                    </span>
                  )}
                  <span
                    className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-red-500 ring-1 ring-ink-900"
                    aria-hidden
                  />
                </span>
                <span className="max-w-[9rem] truncate">{item.channel}</span>
              </button>
            );
          })}
        </div>
      </Collapse>
    </div>
  );
}
