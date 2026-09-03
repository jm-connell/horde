import type {
  AiCurrentJob,
  AiStatus,
  OpenRouterCosts,
  SystemStats,
} from "../../types";
import { formatSize } from "../../utils";
import {
  formatOpenRouterModelLine,
  formatOpenRouterSpendLine,
  ollamaIsUsed,
  openrouterIsUsed,
} from "./aiOllamaUsage";
import { plural } from "./helpers";

function CurrentAiJob({ job }: { job: AiCurrentJob | string }) {
  if (typeof job === "string") {
    return (
      <div className="flex justify-between gap-3">
        <dt className="text-gray-400">Running</dt>
        <dd className="truncate text-right text-xs text-gray-300">{job}</dd>
      </div>
    );
  }

  const kindLabel = job.kind.replace(/_/g, " ");
  const attempts = job.attempts ?? 0;
  return (
    <div className="flex items-stretch justify-between gap-3">
      <dt className="shrink-0 pt-1 text-gray-400">Running</dt>
      <dd className="flex min-w-0 flex-1 items-start justify-end gap-3 text-right">
        <span className="min-w-0">
          <span className="block truncate text-xs text-gray-200">
            {job.title || (job.video_id == null ? kindLabel : "Untitled")}
          </span>
          <span className="block truncate text-[11px] text-gray-500">
            {[
              job.channel,
              kindLabel,
              attempts > 1 ? `attempt ${attempts}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {job.model && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-gray-500">
              {job.model}
            </span>
          )}
          {job.error && attempts > 1 && (
            <span className="mt-0.5 block truncate text-[10px] text-amber-400/90">
              {job.error}
            </span>
          )}
        </span>
        {job.has_thumbnail && job.video_id != null ? (
          <img
            src={`/api/thumbnails/${job.video_id}`}
            alt=""
            className="aspect-video w-28 shrink-0 rounded object-cover ring-1 ring-ink-700"
          />
        ) : null}
      </dd>
    </div>
  );
}

function queueSummary(aiStatus: AiStatus): string {
  const parts: string[] = [];
  const runnable = aiStatus.runnable_count ?? 0;
  const deferred = aiStatus.deferred_count ?? 0;
  const waiting = aiStatus.waiting_count ?? 0;
  const failed = aiStatus.error_count ?? 0;
  if (runnable > 0) parts.push(`${runnable} ready`);
  if (deferred > 0) parts.push(`${deferred} deferred`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (parts.length) return parts.join(" · ");
  if (aiStatus.queue_depth > 0) return `${aiStatus.queue_depth} queued`;
  return "";
}

export default function AiQueueStatus({
  aiStatus,
  systemStats,
  openRouterCosts = null,
  compact = false,
  onPause,
  onResume,
  onIndexMissing,
  indexBusy = false,
}: {
  aiStatus: AiStatus;
  systemStats: SystemStats | null;
  openRouterCosts?: OpenRouterCosts | null;
  compact?: boolean;
  onPause?: () => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onIndexMissing?: () => void | Promise<void>;
  indexBusy?: boolean;
}) {
  const showPauseControls =
    typeof onPause === "function" && typeof onResume === "function";
  const summary = queueSummary(aiStatus);
  const indexGap = Math.max(
    0,
    (aiStatus.total_videos ?? 0) - (aiStatus.indexed_videos ?? 0)
  );
  const queueIdle =
    !aiStatus.current_job &&
    aiStatus.queue_depth === 0 &&
    aiStatus.pulling.length === 0;
  const blocked =
    Boolean(aiStatus.blocked_reason) &&
    aiStatus.queue_depth > 0 &&
    !aiStatus.current_job;
  const showOllamaGpu = ollamaIsUsed(aiStatus);
  const showOpenRouter = openrouterIsUsed(aiStatus);
  const openRouterModelLine = showOpenRouter
    ? formatOpenRouterModelLine(aiStatus)
    : "";
  const openRouterSpendLine = showOpenRouter
    ? formatOpenRouterSpendLine(openRouterCosts)
    : "";

  const statusLabel = !aiStatus.enabled
    ? "Disabled"
    : aiStatus.paused
      ? "Paused"
      : blocked
        ? "Blocked"
        : aiStatus.ready
          ? "Ready"
          : aiStatus.reachable
            ? "Connected (models loading)"
            : "Offline";

  return (
    <dl className="space-y-1.5 text-sm">
      {showPauseControls && (
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">GPU jobs</dt>
          <dd className="text-right">
            {aiStatus.paused ? (
              <button
                type="button"
                onClick={() => void onResume()}
                className="ui-panel ui-interactive rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25"
              >
                Resume
              </button>
            ) : !queueIdle ? (
              <button
                type="button"
                onClick={() => void onPause()}
                className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs text-gray-300 hover:border-amber-500/50 hover:text-amber-300"
              >
                Pause
              </button>
            ) : indexGap > 0 && typeof onIndexMissing === "function" ? (
              <button
                type="button"
                disabled={indexBusy}
                onClick={() => void onIndexMissing()}
                className="ui-panel ui-interactive rounded-lg border border-accent/40 bg-accent/15 px-2.5 py-1 text-xs text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {indexBusy ? "Queuing…" : "Index missing"}
              </button>
            ) : (
              <span className="text-xs text-gray-500">Idle</span>
            )}
          </dd>
        </div>
      )}
      {!compact && (
        <>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Status</dt>
            <dd
              className={
                blocked
                  ? "text-right text-amber-300"
                  : "text-right text-gray-200"
              }
            >
              {statusLabel}
            </dd>
          </div>
          {showOllamaGpu && (
            <div className="flex justify-between gap-3">
              <dt className="text-gray-400">URL</dt>
              <dd className="truncate text-right font-mono text-xs text-gray-300">
                {aiStatus.base_url || "—"}
              </dd>
            </div>
          )}
        </>
      )}
      <div className="flex justify-between gap-3">
        <dt className="text-gray-400">Indexed</dt>
        <dd className="text-right text-gray-200">
          {aiStatus.indexed_videos} / {aiStatus.total_videos}
          {summary
            ? ` · ${summary}`
            : indexGap > 0
              ? ` · ${indexGap} not indexed`
              : ""}
        </dd>
      </div>
      {blocked && aiStatus.blocked_reason && (
        <p className="text-xs text-amber-400/90">{aiStatus.blocked_reason}</p>
      )}
      {aiStatus.current_job && <CurrentAiJob job={aiStatus.current_job} />}
      {showOpenRouter && openRouterModelLine && (
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">OpenRouter</dt>
          <dd className="truncate text-right text-gray-200">
            {openRouterModelLine}
          </dd>
        </div>
      )}
      {showOpenRouter && openRouterSpendLine && (
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">Spend</dt>
          <dd
            className={
              openRouterCosts?.over_budget
                ? "text-right text-amber-200"
                : "text-right text-gray-200"
            }
          >
            {openRouterSpendLine}
          </dd>
        </div>
      )}
      {showOllamaGpu &&
        (aiStatus.gpu_name || aiStatus.vram_total_bytes != null) && (
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Ollama GPU</dt>
            <dd className="text-right text-gray-200">
              {[
                aiStatus.gpu_name,
                aiStatus.vram_total_bytes != null
                  ? formatSize(aiStatus.vram_total_bytes)
                  : null,
                aiStatus.gpu_source === "override"
                  ? "override"
                  : aiStatus.gpu_source === "ollama"
                    ? "from Ollama"
                    : aiStatus.gpu_source === "local"
                      ? "local"
                      : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
      {showOllamaGpu &&
        systemStats?.gpu &&
        (systemStats.gpu.util_percent != null ||
          systemStats.gpu.temp_c != null) && (
          <div className="flex justify-between gap-3">
            <dt className="text-gray-400">Horde host GPU</dt>
            <dd className="text-right text-gray-200">
              {[
                systemStats.gpu.util_percent != null
                  ? `${Math.round(systemStats.gpu.util_percent)}%`
                  : null,
                systemStats.gpu.temp_c != null
                  ? `${Math.round(systemStats.gpu.temp_c)}°C`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </dd>
          </div>
        )}
      {aiStatus.queue_breakdown && aiStatus.queue_depth > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">Queue</dt>
          <dd className="text-right text-xs text-gray-300">
            {[
              aiStatus.queue_breakdown.embed_video
                ? plural(
                    aiStatus.queue_breakdown.embed_video,
                    "search index",
                    "search indexes"
                  )
                : null,
              aiStatus.queue_breakdown.embed_catalog_video
                ? plural(
                    aiStatus.queue_breakdown.embed_catalog_video,
                    "catalog index",
                    "catalog indexes"
                  )
                : null,
              aiStatus.queue_breakdown.enrich_tags
                ? plural(
                    aiStatus.queue_breakdown.enrich_tags,
                    "tag",
                    "tags"
                  )
                : null,
              aiStatus.queue_breakdown.summarize
                ? plural(
                    aiStatus.queue_breakdown.summarize,
                    "summary",
                    "summaries"
                  )
                : null,
              aiStatus.queue_breakdown.refresh_categories
                ? plural(
                    aiStatus.queue_breakdown.refresh_categories,
                    "category",
                    "categories"
                  )
                : null,
            ]
              .filter(Boolean)
              .join(" · ") || `${aiStatus.queue_depth} jobs`}
          </dd>
        </div>
      )}
      {aiStatus.pulling.length > 0 && (
        <div className="flex justify-between gap-3">
          <dt className="text-gray-400">Pulling</dt>
          <dd className="text-right text-amber-300">
            {aiStatus.pulling.join(", ")}
          </dd>
        </div>
      )}
      {aiStatus.last_error && (
        <p className="text-xs text-red-400">{aiStatus.last_error}</p>
      )}
    </dl>
  );
}
