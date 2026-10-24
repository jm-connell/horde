import type { ReactNode } from "react";
import { useSettingsPage } from "../context";
import { Section } from "../ui";
import { STATUS_TIPS } from "../constants";
import {
  downloadErrorLabel,
  extractFailureCopy,
} from "../../../downloadErrors";
import { formatSize } from "../../../utils";
import LoadingIndicator from "../../../components/LoadingIndicator";
import HelpTip from "../../../components/HelpTip";
import type { SystemState } from "../useSystemState";

function LastExtractFailure({
  failure,
}: {
  failure: { kind: string; message: string; target?: string | null };
}) {
  const copy = extractFailureCopy(failure);
  return (
    <>
      <span className="text-red-400">{downloadErrorLabel(failure.kind)}</span>
      {copy.target ? (
        <div className="mt-0.5 text-xs text-gray-200">{copy.target}</div>
      ) : null}
      <div className="mt-0.5 text-xs text-muted">{copy.message}</div>
    </>
  );
}

function StatusRow({
  label,
  tip,
  children,
  ddClassName = "text-right text-gray-200",
}: {
  label: string;
  tip: string;
  children: ReactNode;
  ddClassName?: string;
}) {
  return (
    <HelpTip
      as="div"
      text={tip}
      placement="bottom"
      className="flex w-full cursor-help justify-between gap-4"
    >
      <dt className="text-gray-400">{label}</dt>
      <dd className={ddClassName}>{children}</dd>
    </HelpTip>
  );
}

export default function StatusSection({ system }: { system: SystemState }) {
  const { match } = useSettingsPage();
  const { storage, health, updateCheck } = system;

  return (
    <Section
      title="Status"
      hidden={
        !match(
          "health",
          "yt-dlp",
          "ollama",
          "disk",
          "review",
          "downloads",
          "gpu",
          "system status",
          "update",
          "version",
          "github",
          "git pull",
          "docker",
          "rebuild",
          "po token",
          "cookies",
          "openrouter"
        )
      }
    >
      {health ? (
        <dl className="space-y-2 text-sm">
          <StatusRow
            label="Horde"
            tip={STATUS_TIPS.horde}
            ddClassName="text-right font-mono text-gray-200"
          >
            {health.horde_version ?? "unknown"}
            {updateCheck && !updateCheck.error ? (
              <span className="ml-2 font-sans text-muted">
                {updateCheck.update_available
                  ? "· update available"
                  : health.horde_version && health.horde_version !== "unknown"
                    ? "· up to date"
                    : ""}
              </span>
            ) : null}
          </StatusRow>
          <StatusRow
            label="yt-dlp"
            tip={STATUS_TIPS.ytdlp}
            ddClassName="text-right font-mono text-gray-200"
          >
            {health.yt_dlp_version}
          </StatusRow>
          {health.pot_provider && (
            <StatusRow label="PO token provider" tip={STATUS_TIPS.pot}>
              {health.pot_provider.status === "ok" ? (
                <>
                  Connected
                  {health.pot_provider.version
                    ? ` (v${health.pot_provider.version})`
                    : ""}
                </>
              ) : (
                <span className="text-red-400">
                  {health.pot_provider.detail ?? "Unavailable"}
                </span>
              )}
            </StatusRow>
          )}
          {health.ollama && (
            <StatusRow label="Ollama" tip={STATUS_TIPS.ollama}>
              {!health.ollama.enabled
                ? "Disabled"
                : health.ollama.ready
                  ? "Ready"
                  : health.ollama.reachable
                    ? "Connected"
                    : "Offline"}
              {!health.ollama.enabled || health.ollama.ready ? null : health
                  .ollama.last_error ? (
                <div className="mt-0.5 max-w-xs text-xs text-red-400">
                  {health.ollama.last_error}
                </div>
              ) : null}
            </StatusRow>
          )}
          {health.openrouter && (
            <StatusRow label="OpenRouter" tip={STATUS_TIPS.openrouter}>
              {!health.openrouter.enabled
                ? "Disabled"
                : health.openrouter.configured || health.openrouter.reachable
                  ? "Configured"
                  : "No API key"}
            </StatusRow>
          )}
          <StatusRow label="Cookies" tip={STATUS_TIPS.cookies}>
            {health.youtube?.cookies_configured
              ? "Configured"
              : "Not configured"}
          </StatusRow>
          <StatusRow label="Library" tip={STATUS_TIPS.library}>
            {storage
              ? `${storage.video_count} video${
                  storage.video_count === 1 ? "" : "s"
                } - ${formatSize(storage.total_bytes) || "0 B"}`
              : `${health.library_video_count} video${
                  health.library_video_count === 1 ? "" : "s"
                }`}
          </StatusRow>
          <StatusRow label="Pending import" tip={STATUS_TIPS.pendingImport}>
            {health.review_pending_count}
          </StatusRow>
          <StatusRow label="Active downloads" tip={STATUS_TIPS.downloads}>
            {health.downloads?.active ?? health.active_downloads}
            {health.downloads?.paused ? " · paused" : ""}
            {health.downloads?.held_reason ? (
              <span className="mt-0.5 block text-xs text-amber-400/90">
                {health.downloads.held_reason}
              </span>
            ) : null}
          </StatusRow>
          {health.workers && (
            <>
              <StatusRow label="AI queue" tip={STATUS_TIPS.aiQueue}>
                {health.workers.ai_queue_depth}
                {health.workers.ai_running
                  ? ` · ${health.workers.ai_running} running`
                  : ""}
                {(health.workers.ai_error_count ?? 0) > 0
                  ? ` · ${health.workers.ai_error_count} failed`
                  : ""}
                {health.workers.ai_blocked_reason ? (
                  <span className="mt-0.5 block text-xs text-amber-400/90">
                    {health.workers.ai_blocked_reason}
                  </span>
                ) : null}
              </StatusRow>
              <StatusRow label="Catalog queue" tip={STATUS_TIPS.catalogQueue}>
                {health.workers.catalog_queue_depth}
                {health.workers.catalog_indexing ? " · indexing" : ""}
              </StatusRow>
            </>
          )}
          {health.youtube?.last_extract_failure && (
            <StatusRow
              label="Last extract failure"
              tip={STATUS_TIPS.extractFailure}
              ddClassName="max-w-xs text-right text-gray-200"
            >
              <LastExtractFailure
                failure={health.youtube.last_extract_failure}
              />
            </StatusRow>
          )}
          {health.disk && (
            <StatusRow label="Disk free" tip={STATUS_TIPS.disk}>
              {formatSize(health.disk.free_bytes)} /{" "}
              {formatSize(health.disk.total_bytes)}
            </StatusRow>
          )}
        </dl>
      ) : (
        <LoadingIndicator label="Loading" className="py-4" />
      )}
    </Section>
  );
}
