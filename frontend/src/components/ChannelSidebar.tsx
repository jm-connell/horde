import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import Collapse from "./Collapse";
import type { ChannelStat } from "../types";

const CHANNEL_SIDEBAR_LIMIT = 30;

function formatSubscriberCount(count: number | null) {
  if (count === null) return null;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export default function ChannelSidebar({
  channels,
  activeChannel,
  channelSort,
  showAllChannels,
  onSelectChannel,
  onSelectRemoteChannel,
  onToggleShowAll,
}: {
  channels: ChannelStat[];
  activeChannel: string | null;
  channelSort: string;
  showAllChannels: boolean;
  onSelectChannel: (channel: string | null) => void;
  onSelectRemoteChannel: (hit: {
    name: string;
    url: string;
    subscriber_count: number | null;
  }) => void;
  onToggleShowAll: () => void;
}) {
  const [query, setQuery] = useState("");
  const [remoteHits, setRemoteHits] = useState<
    {
      name: string;
      url: string;
      thumbnail_url: string | null;
      subscriber_count: number | null;
    }[]
  >([]);
  const [searching, setSearching] = useState(false);
  const debounced = useMemo(() => query.trim().toLowerCase(), [query]);

  const libraryMatches = useMemo(() => {
    if (!debounced) return channels;
    return channels.filter((c) => c.channel.toLowerCase().includes(debounced));
  }, [channels, debounced]);

  useEffect(() => {
    if (!debounced || debounced.length < 2) {
      setRemoteHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      api
        .searchChannels(debounced, 8)
        .then((data) => {
          if (cancelled) return;
          const libraryNames = new Set(
            channels.map((c) => c.channel.toLowerCase())
          );
          setRemoteHits(
            (data.results || []).filter(
              (h) => !libraryNames.has(h.name.toLowerCase())
            )
          );
        })
        .catch(() => {
          if (!cancelled) setRemoteHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [debounced, channels]);

  const visibleLibrary = debounced
    ? libraryMatches
    : channels.slice(0, CHANNEL_SIDEBAR_LIMIT);

  return (
    <div className="space-y-2" data-horde="channel-list">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search channels"
        className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-xs text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
      />
      <ul className="space-y-0.5">
        {!debounced && (
          <li>
            <button
              onClick={() => onSelectChannel(null)}
              className={`w-full rounded-lg px-3 py-1.5 text-left text-sm ${
                !activeChannel
                  ? "bg-accent/15 text-accent"
                  : "text-gray-300 hover:bg-ink-800"
              }`}
            >
              All channels
            </button>
          </li>
        )}
        {visibleLibrary.map((c) => (
          <li key={c.channel}>
            <button
              onClick={() => onSelectChannel(c.channel)}
              className={`group flex w-full min-w-0 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm ${
                activeChannel === c.channel
                  ? "bg-accent/15 text-accent"
                  : "text-gray-300 hover:bg-ink-800"
              }`}
            >
              <span className="truncate">{c.channel}</span>
              <span className="ml-2 shrink-0 text-xs text-gray-500">
                {channelSort === "subscriber_count" &&
                c.subscriber_count !== null
                  ? formatSubscriberCount(c.subscriber_count)
                  : c.count}
              </span>
            </button>
          </li>
        ))}
        {!debounced && channels.length > CHANNEL_SIDEBAR_LIMIT && (
          <>
            <Collapse open={showAllChannels}>
              <ul className="space-y-0.5">
                {channels.slice(CHANNEL_SIDEBAR_LIMIT).map((c) => (
                  <li key={c.channel}>
                    <button
                      onClick={() => onSelectChannel(c.channel)}
                      className={`group flex w-full min-w-0 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm ${
                        activeChannel === c.channel
                          ? "bg-accent/15 text-accent"
                          : "text-gray-300 hover:bg-ink-800"
                      }`}
                    >
                      <span className="truncate">{c.channel}</span>
                      <span className="ml-2 shrink-0 text-xs text-gray-500">
                        {channelSort === "subscriber_count" &&
                        c.subscriber_count !== null
                          ? formatSubscriberCount(c.subscriber_count)
                          : c.count}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Collapse>
            <li>
              <button
                type="button"
                onClick={onToggleShowAll}
                className="w-full rounded-lg px-3 py-1.5 text-left text-xs font-medium text-accent hover:bg-ink-800"
              >
                {showAllChannels
                  ? "Show less"
                  : `Show more (${channels.length - CHANNEL_SIDEBAR_LIMIT})`}
              </button>
            </li>
          </>
        )}
        {debounced && (
          <>
            {searching && (
              <li className="px-3 py-1.5 text-xs text-gray-500">Searching…</li>
            )}
            {remoteHits.length > 0 && (
              <li className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                From YouTube
              </li>
            )}
            {remoteHits.map((hit) => (
              <li key={hit.url}>
                <button
                  type="button"
                  onClick={() =>
                    onSelectRemoteChannel({
                      name: hit.name,
                      url: hit.url,
                      subscriber_count: hit.subscriber_count,
                    })
                  }
                  className="flex w-full min-w-0 items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-ink-800"
                >
                  <span className="truncate">{hit.name}</span>
                  <span className="ml-2 shrink-0 text-xs text-gray-500">
                    {hit.subscriber_count != null
                      ? formatSubscriberCount(hit.subscriber_count)
                      : "New"}
                  </span>
                </button>
              </li>
            ))}
            {!searching &&
              libraryMatches.length === 0 &&
              remoteHits.length === 0 && (
                <li className="px-3 py-1.5 text-xs text-gray-500">
                  No channels found
                </li>
              )}
          </>
        )}
      </ul>
    </div>
  );
}
