import { useId, useState, type ReactNode } from "react";
import Collapse from "../../components/Collapse";
import { useSettings } from "../../hooks/useSettings";
import { useHistoryStats } from "../../queries/history";
import type {
  HistoryStats,
  HistoryStatsDay,
  HistoryStatsRange,
} from "../../types";
import StatsDetails, { ChannelInitial } from "./StatsDetails";
import {
  compareWeeks,
  formatWatchTime,
  formatWatchTimeLong,
} from "./statsFormat";

/** The tiles always describe the last 30 days; the details have their own range. */
const SUMMARY_RANGE: HistoryStatsRange = "30d";

function Tile({
  label,
  value,
  sub,
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub: ReactNode;
  className?: string;
}) {
  return (
    <span className={`block min-w-0 ${className}`}>
      <span className="block text-xs text-muted">{label}</span>
      <span className="mt-1 flex min-w-0 items-center gap-2 text-2xl font-semibold leading-8 text-gray-100">
        {value}
      </span>
      <span className="mt-0.5 block truncate text-xs text-muted">{sub}</span>
    </span>
  );
}

function Arrow({ up }: { up: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className={`inline h-2.5 w-2.5 ${up ? "" : "rotate-180"}`}
      fill="currentColor"
    >
      <path d="M6 2 11 9H1z" />
    </svg>
  );
}

function WeekDelta({ days }: { days: HistoryStatsDay[] }) {
  const { lastWeek, changePct } = compareWeeks(days);
  if (changePct === null) return <>{lastWeek > 0 ? "" : "nothing last week"}</>;
  if (changePct === 0) return <>same as last week</>;
  const up = changePct > 0;
  return (
    <>
      <Arrow up={up} />
      <span className="sr-only">{up ? "up" : "down"}</span>{" "}
      {Math.abs(changePct)}% vs last week
    </>
  );
}

/** The last 30 days as a strip of thin columns, today in full accent. */
function ActivityStrip({
  days,
  className = "",
}: {
  days: HistoryStatsDay[];
  className?: string;
}) {
  const max = Math.max(0, ...days.map((d) => d.seconds));
  return (
    <span className={`flex min-w-0 flex-col ${className}`}>
      <span className="flex justify-between text-xs text-muted">
        <span>Last 30 days</span>
        <span aria-hidden="true">Today</span>
      </span>
      <span
        aria-hidden="true"
        className="mt-1.5 flex h-11 items-end gap-[2px] border-b border-ink-600"
      >
        {days.map((d, i) => (
          <span
            key={d.day}
            className={`min-w-0 flex-1 rounded-t-[3px] ${
              i === days.length - 1 ? "bg-accent" : "bg-accent/50"
            }`}
            style={{
              height:
                d.seconds > 0 && max > 0
                  ? `max(3px, ${(d.seconds / max) * 100}%)`
                  : 0,
            }}
          />
        ))}
      </span>
    </span>
  );
}

function streakSub(stats: HistoryStats): string {
  const streak = stats.totals.current_streak_days;
  const today = stats.days[stats.days.length - 1];
  if (streak === 0) return "watch today to start one";
  if (!today || today.seconds === 0) return "watch today to keep it going";
  return streak === 1 ? "today" : "days in a row";
}

function Tiles({ stats }: { stats: HistoryStats }) {
  const week = compareWeeks(stats.days);
  const streak = stats.totals.current_streak_days;
  const top = stats.channels[0];
  return (
    <span className="grid grid-cols-2 gap-x-4 gap-y-4 lg:grid-cols-[repeat(4,minmax(0,1fr))_minmax(0,1.5fr)] lg:gap-x-0">
      <Tile
        label="Watched this week"
        value={
          <>
            <span aria-hidden="true">{formatWatchTime(week.thisWeek)}</span>
            <span className="sr-only">
              {formatWatchTimeLong(week.thisWeek)}
            </span>
          </>
        }
        sub={<WeekDelta days={stats.days} />}
      />
      <Tile
        label="Videos finished"
        value={stats.totals.videos_finished.toLocaleString()}
        sub="last 30 days"
        className="lg:border-l lg:border-ink-700 lg:pl-5"
      />
      <Tile
        label="Streak"
        value={`${streak} day${streak === 1 ? "" : "s"}`}
        sub={streakSub(stats)}
        className="lg:border-l lg:border-ink-700 lg:pl-5"
      />
      <Tile
        label="Top channel"
        value={
          top ? (
            <>
              <ChannelInitial name={top.name} size="sm" />
              <span className="truncate text-lg">{top.name}</span>
            </>
          ) : (
            <span className="text-lg text-muted">None yet</span>
          )
        }
        sub={top ? `${formatWatchTime(top.seconds)} · last 30 days` : ""}
        className="lg:border-l lg:border-ink-700 lg:pl-5"
      />
      <ActivityStrip
        days={stats.days}
        className="col-span-2 lg:col-span-1 lg:border-l lg:border-ink-700 lg:pl-5"
      />
    </span>
  );
}

function Skeleton() {
  return (
    <div
      aria-hidden="true"
      className="mb-6 h-[150px] animate-pulse rounded-xl border border-ink-700 bg-ink-900 motion-reduce:animate-none"
    />
  );
}

/**
 * The stats band above the History list: four tiles and a 30-day strip, the
 * whole band a button that opens the charts below it (remembered per account).
 * Only ever the signed-in account's own numbers.
 */
export default function HistoryStatsBand() {
  const [settings, updateSettings] = useSettings();
  const expanded = settings.historyStatsExpanded;
  const [range, setRange] = useState<HistoryStatsRange>(SUMMARY_RANGE);
  const summary = useHistoryStats(SUMMARY_RANGE);
  const details = useHistoryStats(range, expanded);
  const detailsId = useId();

  if (summary.isPending) return <Skeleton />;
  if (summary.isError) {
    return (
      <p className="mb-6 rounded-xl border border-ink-700 bg-ink-900 px-4 py-3 text-sm text-muted">
        Your stats could not be loaded.
      </p>
    );
  }
  const stats = summary.data;
  const empty =
    stats.totals.watch_seconds === 0 &&
    stats.totals.videos_started === 0 &&
    stats.library.watched_videos === 0 &&
    stats.totals.current_streak_days === 0;
  if (empty) {
    return (
      <div className="ui-card-enter mb-6 flex items-center gap-3 rounded-xl border border-dashed border-ink-700 bg-ink-900 px-4 py-4">
        <span
          aria-hidden="true"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor">
            <path d="M3 17h3V9H3v8Zm5.5 0h3V3h-3v14Zm5.5 0h3v-5h-3v5Z" />
          </svg>
        </span>
        <p className="text-sm text-muted">
          <span className="font-medium text-gray-200">Your stats</span> · Watch
          something and your stats will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => updateSettings({ historyStatsExpanded: !expanded })}
        className="ui-card-enter group block w-full rounded-xl border border-ink-700 bg-ink-900 p-4 text-left transition-colors hover:border-ink-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:px-5"
      >
        <span className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm font-semibold text-gray-200">
            Your stats
          </span>
          <span className="flex items-center gap-1 text-xs text-muted transition-colors group-hover:text-gray-200">
            {expanded ? "Fewer stats" : "More stats"}
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              className={`h-4 w-4 transition-transform duration-300 ${
                expanded ? "rotate-180" : ""
              }`}
              fill="currentColor"
            >
              <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4Z" />
            </svg>
          </span>
        </span>
        <Tiles stats={stats} />
      </button>
      <Collapse open={expanded}>
        <div id={detailsId} className="pt-4">
          <StatsDetails
            stats={details.data}
            range={range}
            onRange={setRange}
            refreshing={details.isPlaceholderData}
          />
        </div>
      </Collapse>
    </div>
  );
}
