import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ChannelSearchHit, ChannelStat } from "../types";
import { formatCompactCount } from "../utils";
import ChannelAvatar from "./ChannelAvatar";
import Collapse from "./Collapse";
import { GridIcon } from "./icons";
import LiveNowSection from "./LiveNowSection";

const CHANNEL_SIDEBAR_LIMIT = 30;
/** Every row: a 24px picture, the name, a number at the right edge. */
const ROW =
  "flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm";
const ROW_ACTIVE = "bg-accent/15 text-accent";
const ROW_IDLE = "text-gray-300 hover:bg-ink-800";
const AVATAR = "h-6 w-6";

function formatSubscriberCount(count: number | null | undefined) {
  if (count == null) return null;
  return formatCompactCount(count);
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
  const [remoteHits, setRemoteHits] = useState<ChannelSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const debounced = useMemo(() => query.trim().toLowerCase(), [query]);

  // A subscribed channel with no downloads opens as a remote one: its page
  // is its YouTube feed.
  const open = (c: ChannelStat) => {
    if (c.count === 0 && c.channel_url)
      onSelectRemoteChannel({
        name: c.channel,
        url: c.channel_url,
        subscriber_count: c.subscriber_count ?? null,
      });
    else onSelectChannel(c.channel);
  };

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

  const hidden = Math.max(0, channels.length - CHANNEL_SIDEBAR_LIMIT);

  const row = (c: ChannelStat, loadAvatar = true) => (
    <li key={c.channel}>
      <ChannelRow
        name={c.channel}
        channelUrl={loadAvatar ? (c.channel_url ?? null) : null}
        active={activeChannel === c.channel}
        meta={
          channelSort === "subscriber_count" && c.subscriber_count != null
            ? formatSubscriberCount(c.subscriber_count)
            : c.count || null
        }
        onClick={() => open(c)}
      />
    </li>
  );

  return (
    <div className="space-y-2" data-horde="channel-list">
      <LiveNowSection />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search channels"
        aria-label="Search channels"
        className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-xs text-gray-100 placeholder-muted outline-hidden focus:border-accent"
      />
      <ul className="space-y-0.5">
        {debounced ? (
          <>
            {libraryMatches.map((c) => row(c))}
            {searching && (
              <li className="px-2 py-1.5 text-xs text-muted">Searching…</li>
            )}
            {remoteHits.length > 0 && <SectionLabel>From YouTube</SectionLabel>}
            {remoteHits.map((hit) => (
              <li key={hit.url}>
                <ChannelRow
                  name={hit.name}
                  // No picture: reading one per result per keystroke is not worth it.
                  channelUrl={null}
                  active={false}
                  meta={
                    hit.subscriber_count != null
                      ? formatSubscriberCount(hit.subscriber_count)
                      : "New"
                  }
                  onClick={() =>
                    onSelectRemoteChannel({
                      name: hit.name,
                      url: hit.url,
                      subscriber_count: hit.subscriber_count ?? null,
                    })
                  }
                />
              </li>
            ))}
            {!searching &&
              libraryMatches.length === 0 &&
              remoteHits.length === 0 && (
                <li className="px-2 py-1.5 text-xs text-muted">
                  No channels found
                </li>
              )}
          </>
        ) : (
          <>
            <li>
              <button
                type="button"
                onClick={() => onSelectChannel(null)}
                className={`${ROW} ${!activeChannel ? ROW_ACTIVE : ROW_IDLE}`}
              >
                <span
                  aria-hidden="true"
                  className={`${AVATAR} flex shrink-0 items-center justify-center rounded-full bg-ink-800 text-muted`}
                >
                  <GridIcon />
                </span>
                <span className="min-w-0 flex-1 truncate">All channels</span>
              </button>
            </li>
            {/* Channels with downloads, then those only subscribed to
                (no count): being listed says as much. */}
            {channels.slice(0, CHANNEL_SIDEBAR_LIMIT).map((c) => row(c))}
            {hidden > 0 && (
              <Collapse open={showAllChannels}>
                <ul className="space-y-0.5">
                  {/* Pictures load once the rows are shown. */}
                  {channels
                    .slice(CHANNEL_SIDEBAR_LIMIT)
                    .map((c) => row(c, showAllChannels))}
                </ul>
              </Collapse>
            )}
            {hidden > 0 && (
              <li>
                <button
                  type="button"
                  onClick={onToggleShowAll}
                  className="w-full rounded-lg px-2 py-1.5 text-left text-xs font-medium text-accent hover:bg-ink-800"
                >
                  {showAllChannels ? "Show less" : `Show more (${hidden})`}
                </button>
              </li>
            )}
          </>
        )}
      </ul>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <li className="px-2 pb-0.5 pt-3 text-[10px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </li>
  );
}

/** One channel: its picture, its name, and a number at the right edge. */
function ChannelRow({
  name,
  channelUrl,
  active,
  meta,
  onClick,
}: {
  name: string;
  /** Loads the profile picture; null shows the initial. */
  channelUrl: string | null;
  active: boolean;
  meta: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`${ROW} ${active ? ROW_ACTIVE : ROW_IDLE}`}
    >
      <ChannelAvatar
        channel={name}
        channelUrl={channelUrl}
        size={`${AVATAR} text-[11px]`}
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {meta != null && (
        <span className="shrink-0 text-xs tabular-nums text-muted">{meta}</span>
      )}
    </button>
  );
}
