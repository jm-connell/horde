import { useEffect, useState } from "react";
import type { ActivityTask, SystemActivity } from "../../types";

const RECENT_MAX = 50;

const GROUP_LABELS: Record<string, string> = {
  media: "Media",
  download: "Download",
  ai: "AI",
  index: "Index",
  library: "Library",
};

const QUEUED_LABELS: Record<string, string> = {
  sprites: "seek previews",
  ai: "AI jobs",
  catalog: "channel catalogs",
  download: "downloads",
};

function formatElapsed(startedAt: number, finishedAt?: number | null): string {
  const end = finishedAt ?? Date.now() / 1000;
  const sec = Math.max(0, Math.floor(end - startedAt));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function EngineChip({ engine }: { engine: string | null }) {
  if (!engine) return null;
  return (
    <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-amber-300/90">
      {engine}
    </span>
  );
}

function GroupBadge({ group }: { group: string }) {
  return (
    <span className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
      {GROUP_LABELS[group] || group}
    </span>
  );
}

function ProgressBar({
  done,
  total,
}: {
  done: number | null;
  total: number | null;
}) {
  if (total == null || total <= 0 || done == null) return null;
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  return (
    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-ink-800">
      <div
        className="h-full rounded-full bg-sky-500/80 transition-[width] duration-500"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function RunningRow({ task, now }: { task: ActivityTask; now: number }) {
  return (
    <li className="rounded-md border border-ink-700/80 bg-ink-900/40 px-2.5 py-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <GroupBadge group={task.group} />
            <EngineChip engine={task.engine} />
            <span className="text-sm font-medium text-gray-100">
              {task.label}
            </span>
          </div>
          {task.detail && (
            <p className="mt-0.5 truncate text-xs text-gray-300">{task.detail}</p>
          )}
          {task.reason && (
            <p className="mt-0.5 text-xs text-gray-500">{task.reason}</p>
          )}
        </div>
        <div className="shrink-0 text-right text-xs tabular-nums text-gray-400">
          {formatElapsed(task.started_at, now / 1000)}
          {task.total != null && task.done != null && (
            <div className="text-gray-500">
              {task.done}/{task.total}
            </div>
          )}
        </div>
      </div>
      <ProgressBar done={task.done} total={task.total} />
    </li>
  );
}

function RecentRow({ task }: { task: ActivityTask }) {
  const failed = task.status === "failed";
  const cancelled = task.status === "cancelled";
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 py-1.5 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <GroupBadge group={task.group} />
          <EngineChip engine={task.engine} />
          <span
            className={
              failed
                ? "text-red-300"
                : cancelled
                  ? "text-gray-500"
                  : "text-gray-300"
            }
          >
            {task.label}
          </span>
        </div>
        {task.detail && (
          <p className="mt-0.5 truncate text-gray-500">{task.detail}</p>
        )}
        {failed && task.error && (
          <p className="mt-0.5 text-red-400">{task.error}</p>
        )}
      </div>
      <div className="shrink-0 text-right tabular-nums text-gray-500">
        {formatElapsed(task.started_at, task.finished_at)}
        <div
          className={
            failed
              ? "text-red-400"
              : cancelled
                ? "text-gray-600"
                : "text-emerald-500/80"
          }
        >
          {task.status}
        </div>
      </div>
    </li>
  );
}

export default function BackgroundActivity({
  activity,
}: {
  activity: SystemActivity | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!activity) {
    return <p className="text-sm text-gray-500">Loading activity…</p>;
  }

  const running = activity.running ?? [];
  const recent = (activity.recent ?? []).slice(0, RECENT_MAX);
  const queued = activity.queued ?? {};
  const queuedEntries = Object.entries(queued).filter(([, n]) => n > 0);
  const cpu =
    activity.cpu_percent != null ? Math.round(activity.cpu_percent) : null;
  const ffmpegRunning = running.filter((t) => t.engine === "ffmpeg").length;

  let summary: string;
  if (running.length === 0 && queuedEntries.length === 0) {
    summary = "Idle — nothing running";
  } else {
    const parts: string[] = [];
    if (running.length) {
      parts.push(
        `${running.length} task${running.length === 1 ? "" : "s"} running`
      );
    }
    if (cpu != null) parts.push(`CPU ${cpu}%`);
    if (ffmpegRunning) {
      parts.push(
        `${ffmpegRunning} ffmpeg${ffmpegRunning === 1 ? "" : "s"}`
      );
    }
    summary = parts.join(" · ");
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-200">{summary}</p>

      {queuedEntries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {queuedEntries.map(([kind, n]) => (
            <span
              key={kind}
              className="rounded-full border border-ink-700 bg-ink-900/50 px-2 py-0.5 text-[11px] text-gray-400"
            >
              {n} queued {QUEUED_LABELS[kind] || kind}
            </span>
          ))}
        </div>
      )}

      {running.length > 0 ? (
        <ul className="space-y-2">
          {running.map((task) => (
            <RunningRow key={task.id} task={task} now={now} />
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">
          When Horde runs ffmpeg, downloads, AI jobs, or folder scans, they show
          up here with why they started.
        </p>
      )}

      {recent.length > 0 && (
        <div className="border-t border-ink-800 pt-3">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
            Recent activity
          </p>
          <ul
            className="horde-scrollbar max-h-[calc(8*2.75rem)] divide-y divide-ink-800/80 overflow-y-auto overscroll-contain pr-1"
            aria-label="Recent activity"
          >
            {recent.map((task) => (
              <RecentRow key={`${task.id}-${task.finished_at}`} task={task} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
