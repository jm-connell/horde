import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import type {
  HistoryStats,
  HistoryStatsChannel,
  HistoryStatsRange,
} from "../../types";
import { formatSize } from "../../utils";
import HourHeatmap from "./HourHeatmap";
import {
  binDays,
  binSize,
  formatDay,
  formatShare,
  formatWatchTime,
  RANGE_OPTIONS,
  rangePhrase,
} from "./statsFormat";
import WatchTimeChart from "./WatchTimeChart";

/** A week of hours without watch time (only YouTube views to show). */
const EMPTY_HOURS: number[][] = Array.from({ length: 7 }, () =>
  Array<number>(24).fill(0)
);

export function ChannelInitial({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent/15 font-semibold text-accent ${
        size === "sm" ? "h-7 w-7 text-xs" : "h-8 w-8 text-sm"
      }`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Card({
  title,
  aside,
  className = "",
  children,
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`ui-card-enter min-w-0 rounded-xl border border-ink-700 bg-ink-900 p-4 ${className}`}
    >
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-200">{title}</h2>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

function RangeSwitch({
  value,
  onChange,
}: {
  value: HistoryStatsRange;
  onChange: (range: HistoryStatsRange) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Period"
      className="inline-flex rounded-lg border border-ink-700 bg-ink-900 p-0.5"
    >
      {RANGE_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent ${
            option.value === value
              ? "bg-accent/15 text-accent"
              : "text-gray-400 hover:text-gray-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function channelAmount(stats: HistoryStats, channel: HistoryStatsChannel) {
  const parts = [];
  if (channel.seconds > 0) parts.push(formatWatchTime(channel.seconds));
  if (stats.includes_youtube && channel.youtube_views > 0)
    parts.push(
      `${channel.youtube_views.toLocaleString()} YouTube view${channel.youtube_views === 1 ? "" : "s"}`
    );
  return parts.join(" · ") || formatWatchTime(0);
}

function TopChannels({ stats }: { stats: HistoryStats }) {
  // With YouTube views (no time), channels rank by videos watched.
  const measure = (c: HistoryStatsChannel) =>
    stats.includes_youtube ? c.videos : c.seconds;
  const top = stats.channels[0] ? measure(stats.channels[0]) : 0;
  if (stats.channels.length === 0)
    return <Empty>No channels {rangePhrase(stats.range)}.</Empty>;
  return (
    <ol className="-mx-2 space-y-1">
      {stats.channels.map((channel) => (
        <li key={channel.name}>
          <Link
            to={`/?channel=${encodeURIComponent(channel.name)}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChannelInitial name={channel.name} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2 text-sm">
                <span className="truncate text-gray-200">{channel.name}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {channelAmount(stats, channel)}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="mt-1 block h-1.5 overflow-hidden rounded-full bg-ink-800"
              >
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{
                    width: `${top > 0 ? (measure(channel) / top) * 100 : 0}%`,
                  }}
                />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

const ADDED_LABEL: Record<HistoryStatsRange, string> = {
  "7d": "Added in 7 days",
  "30d": "Added in 30 days",
  "365d": "Added this year",
  all: "Added, all time",
};

function TagsAndLibrary({ stats }: { stats: HistoryStats }) {
  const lib = stats.library;
  return (
    <div className="space-y-5">
      {stats.tags.length === 0 ? (
        <p className="text-sm text-muted">
          No tags on what you watched {rangePhrase(stats.range)}.
        </p>
      ) : (
        <ul aria-label="Top tags" className="flex flex-wrap gap-1.5">
          {stats.tags.map((tag) => (
            <li key={tag.tag}>
              <Link
                to={`/?tag=${encodeURIComponent(tag.tag)}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-ink-700 px-2.5 py-0.5 text-xs text-gray-300 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
              >
                {tag.tag}
                <span className="text-muted">
                  {formatWatchTime(tag.seconds)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-ink-700 pt-4">
        <h3 className="mb-2 text-xs font-medium text-muted">Library</h3>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-muted">Videos</dt>
            <dd className="font-semibold text-gray-100">
              {lib.total_videos.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Size</dt>
            <dd className="font-semibold text-gray-100">
              {formatSize(lib.total_size_bytes) || "0 B"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{ADDED_LABEL[stats.range]}</dt>
            <dd className="font-semibold text-gray-100">
              {lib.added_in_range.toLocaleString()}
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-gray-300">
          You’ve watched{" "}
          <span className="font-semibold text-gray-100">
            {formatShare(lib.watched_share)}
          </span>{" "}
          of the library{" "}
          <span className="text-muted">
            ({lib.watched_videos.toLocaleString()} of{" "}
            {lib.total_videos.toLocaleString()})
          </span>
        </p>
        <div
          aria-hidden="true"
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-800"
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, lib.watched_share * 100)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** The expanded half of the stats band: one period, every chart. */
export default function StatsDetails({
  stats,
  range,
  onRange,
  refreshing,
}: {
  stats: HistoryStats | undefined;
  range: HistoryStatsRange;
  onRange: (range: HistoryStatsRange) => void;
  refreshing: boolean;
}) {
  const totals = stats?.totals;
  const unit = stats
    ? ({ 1: "day", 7: "week", 30: "month" } as const)[
        binSize(stats.days.length) as 1 | 7 | 30
      ]
    : "day";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeSwitch value={range} onChange={onRange} />
        {totals && stats && (
          <p className="text-sm text-muted" aria-live="polite">
            <span className="font-medium text-gray-200">
              {formatWatchTime(totals.watch_seconds)}
            </span>{" "}
            watched · {totals.active_days} active day
            {totals.active_days === 1 ? "" : "s"} · {totals.videos_started}{" "}
            video{totals.videos_started === 1 ? "" : "s"} started
            {stats.includes_youtube && totals.youtube_views > 0 && (
              <>
                {" "}
                · {totals.youtube_views.toLocaleString()} YouTube view
                {totals.youtube_views === 1 ? "" : "s"}
              </>
            )}
            {stats.best_day && (
              <>
                {" "}
                · best day {formatDay(stats.best_day.day)} (
                {formatWatchTime(stats.best_day.seconds)})
              </>
            )}
          </p>
        )}
      </div>
      {!stats ? (
        <div className="grid gap-4 lg:grid-cols-3">
          {[2, 1, 2, 1].map((span, i) => (
            <div
              key={i}
              className={`h-56 animate-pulse rounded-xl border border-ink-700 bg-ink-900 motion-reduce:animate-none ${
                span === 2 ? "lg:col-span-2" : ""
              }`}
            />
          ))}
        </div>
      ) : (
        <div
          className={`grid gap-4 transition-opacity lg:grid-cols-3 ${
            refreshing ? "opacity-60" : ""
          }`}
        >
          <Card
            title="Watch time"
            aside={`per ${unit}`}
            className="lg:col-span-2"
          >
            {stats.totals.watch_seconds > 0 ? (
              <WatchTimeChart bars={binDays(stats.days)} unit={unit} />
            ) : (
              <Empty>No watch time {rangePhrase(stats.range)}.</Empty>
            )}
          </Card>
          <Card title="Top channels">
            <TopChannels stats={stats} />
          </Card>
          <Card
            title="When you watch"
            aside="by weekday and hour"
            className="lg:col-span-2"
          >
            {stats.hours || stats.youtube_hours ? (
              <HourHeatmap
                hours={stats.hours ?? EMPTY_HOURS}
                youtubeViews={stats.youtube_hours}
              />
            ) : (
              <Empty>Nothing watched {rangePhrase(stats.range)}.</Empty>
            )}
          </Card>
          <Card title="Top tags">
            <TagsAndLibrary stats={stats} />
          </Card>
        </div>
      )}
    </div>
  );
}
