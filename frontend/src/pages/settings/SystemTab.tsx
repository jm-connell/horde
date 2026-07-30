import { useSettingsPage } from "./context";
import { Section } from "./ui";
import { PANEL_BTN } from "./constants";
import { saveDismissedUpdateSha } from "./helpers";
import { api } from "../../api";
import { downloadErrorLabel } from "../../downloadErrors";
import { formatSize } from "../../utils";
import LoadingIndicator from "../../components/LoadingIndicator";
import AiQueueStatus from "./AiQueueStatus";
import SystemStatsSnippet from "./SystemStatsSnippet";

export default function SystemTab() {
  const {
    match,
    showToast,
    storage,
    health,
    updateCheck,
    updateChecking,
    refreshUpdates,
    showUpdateNotice,
    setDismissedUpdateSha,
    catalogStatus,
    catalogIndexing,
    setCatalogIndexing,
    refreshCatalogStatus,
    aiStatus,
    systemStats,
    saveAi,
    appSettings,
    metadataSyncStatus,
  } = useSettingsPage();

  return (
    <>
      {showUpdateNotice && updateCheck && (
        <div className="mb-6 rounded-lg border border-ink-700 bg-ink-950/60 px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-gray-200">
                A newer version is available
                {updateCheck.current_short && updateCheck.latest_short ? (
                  <span className="text-gray-500">
                    {" "}
                    (
                    <span className="font-mono">
                      {updateCheck.current_short}
                    </span>
                    {" → "}
                    <span className="font-mono">
                      {updateCheck.latest_short}
                    </span>
                    )
                  </span>
                ) : null}
              </p>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-400">
                  How to update
                </summary>
                <div className="mt-2 space-y-2 text-xs text-gray-400">
                  <p>
                    On the TrueNAS shell (not Dockge Bash), go to your stack
                    folder and run:
                  </p>
                  <pre className="overflow-x-auto rounded bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
                    {`cd /mnt/tank/dockge/stacks/horde   # adjust to your path
bash update.sh`}
                  </pre>
                  <p>
                    Use <span className="font-mono">bash update.sh</span> so
                    you do not need <span className="font-mono">chmod +x</span>
                    . Then hard-refresh the browser (
                    <kbd className="font-mono">Ctrl+Shift+R</kbd>
                    ). Library data stays on host volumes.
                  </p>
                  {updateCheck.latest_html_url && (
                    <a
                      href={updateCheck.latest_html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-block text-accent hover:underline"
                    >
                      View latest commit on GitHub
                    </a>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-400">
                      Advanced: manual commands
                    </summary>
                    <pre className="mt-2 overflow-x-auto rounded bg-ink-900/80 p-2 font-mono text-[11px] leading-relaxed text-gray-300">
                      {`git pull
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose build horde
sudo HORDE_GIT_SHA=$(git rev-parse HEAD) docker compose up -d`}
                    </pre>
                  </details>
                </div>
              </details>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                disabled={updateChecking}
                onClick={() => void refreshUpdates(true)}
                className="text-xs text-gray-500 hover:text-gray-300 disabled:opacity-50"
              >
                {updateChecking ? "Checking…" : "Check again"}
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!updateCheck.latest_sha) return;
                  saveDismissedUpdateSha(updateCheck.latest_sha);
                  setDismissedUpdateSha(updateCheck.latest_sha);
                }}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <Section
        first
        title="Storage"
        hidden={!match("storage", "disk", "space", "library")}
      >
        {storage ? (
          <div className="flex items-baseline gap-3">
            <span className="text-2xl font-bold text-gray-100">
              {formatSize(storage.total_bytes) || "0 B"}
            </span>
            <span className="text-xs text-gray-500">
              {storage.video_count} video
              {storage.video_count === 1 ? "" : "s"}
            </span>
          </div>
        ) : (
          <p className="text-sm text-gray-500">Calculating...</p>
        )}
      </Section>

      <Section
        title="Backup"
        hidden={
          !match(
            "backup",
            "restore",
            "snapshot",
            "volume",
            "data",
            "downloads path",
            "zfs"
          )
        }
      >
        <div className="max-w-2xl space-y-3 text-sm text-gray-300">
          <p>
            Back up both host volumes your Compose stack mounts:{" "}
            <span className="font-medium text-gray-200">DATA</span> (SQLite DB,
            settings, caches) and{" "}
            <span className="font-medium text-gray-200">DOWNLOADS</span> (media
            files). Keeping them in sync preserves library paths and rows.
          </p>
          <p className="text-xs text-gray-500">
            Prefer stopping Horde briefly (or pausing downloads/AI) so SQLite
            and in-flight downloads are quiet. On TrueNAS, a ZFS snapshot of
            both datasets works well. Thumbnails, sprites, and embeddings can be
            regenerated after restore.
          </p>
          {health?.wiki_available ? (
            <a
              href="/wiki/ops/backup-restore/"
              target="_blank"
              rel="noreferrer"
              className={PANEL_BTN}
            >
              Backup &amp; restore guide
            </a>
          ) : (
            <p className="text-xs text-gray-500">
              Full checklist:{" "}
              <span className="font-mono text-gray-400">
                docs/ops/backup-restore.md
              </span>{" "}
              (wiki not bundled in this run).
            </p>
          )}
        </div>
      </Section>

      <Section
        title="Resources"
        hidden={
          !match(
            "resources",
            "cpu",
            "ram",
            "gpu",
            "vram",
            "temperature",
            "nvidia",
            "amd",
            "intel",
            "rocm",
            "system"
          )
        }
      >
        <p className="mb-3 max-w-2xl text-xs text-gray-500">
          Horde host CPU, RAM, and GPU. AI workload sizing uses the Ollama
          machine instead (see AI → Providers).
        </p>
        <SystemStatsSnippet stats={systemStats} />
      </Section>

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
            "rebuild"
          )
        }
      >
        {health ? (
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-gray-400">Horde</dt>
              <dd className="text-right font-mono text-gray-200">
                {health.horde_version ?? "unknown"}
                {updateCheck && !updateCheck.error ? (
                  <span className="ml-2 font-sans text-gray-500">
                    {updateCheck.update_available
                      ? "· update available"
                      : health.horde_version &&
                          health.horde_version !== "unknown"
                        ? "· up to date"
                        : ""}
                  </span>
                ) : null}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">yt-dlp</dt>
              <dd className="font-mono text-gray-200">
                {health.yt_dlp_version}
              </dd>
            </div>
            {health.pot_provider && (
              <div className="flex justify-between">
                <dt className="text-gray-400">PO token provider</dt>
                <dd className="text-gray-200">
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
                </dd>
              </div>
            )}
            {health.ollama && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-400">Ollama</dt>
                <dd className="text-right text-gray-200">
                  {!health.ollama.enabled
                    ? "Disabled"
                    : health.ollama.ready
                      ? "Ready"
                      : health.ollama.reachable
                        ? "Connected"
                        : "Offline"}
                  {!health.ollama.enabled || health.ollama.ready
                    ? null
                    : health.ollama.last_error ? (
                        <div className="mt-0.5 max-w-xs text-xs text-red-400">
                          {health.ollama.last_error}
                        </div>
                      ) : null}
                </dd>
              </div>
            )}
            {health.openrouter && (
              <div className="flex justify-between">
                <dt className="text-gray-400">OpenRouter</dt>
                <dd className="text-gray-200">
                  {!health.openrouter.enabled
                    ? "Disabled"
                    : health.openrouter.configured ||
                        health.openrouter.reachable
                      ? "Configured"
                      : "No API key"}
                </dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-gray-400">Cookies</dt>
              <dd className="text-gray-200">
                {health.youtube?.cookies_configured
                  ? "Configured"
                  : "Not configured"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Library</dt>
              <dd className="text-gray-200">
                {health.library_video_count} videos
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Pending import</dt>
              <dd className="text-gray-200">{health.review_pending_count}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-400">Active downloads</dt>
              <dd className="text-gray-200">
                {health.downloads?.active ?? health.active_downloads}
                {health.downloads?.paused ? " · paused" : ""}
              </dd>
            </div>
            {health.workers && (
              <>
                <div className="flex justify-between">
                  <dt className="text-gray-400">AI queue</dt>
                  <dd className="text-right text-gray-200">
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
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-400">Catalog queue</dt>
                  <dd className="text-gray-200">
                    {health.workers.catalog_queue_depth}
                    {health.workers.catalog_indexing ? " · indexing" : ""}
                  </dd>
                </div>
              </>
            )}
            {health.youtube?.last_extract_failure && (
              <div className="flex justify-between gap-4">
                <dt className="text-gray-400">Last extract failure</dt>
                <dd className="max-w-xs text-right text-gray-200">
                  <span className="text-red-400">
                    {downloadErrorLabel(
                      health.youtube.last_extract_failure.kind
                    )}
                  </span>
                  <div className="mt-0.5 text-xs text-gray-500">
                    {health.youtube.last_extract_failure.message}
                  </div>
                </dd>
              </div>
            )}
            {health.disk && (
              <div className="flex justify-between">
                <dt className="text-gray-400">Disk free</dt>
                <dd className="text-gray-200">
                  {formatSize(health.disk.free_bytes)} /{" "}
                  {formatSize(health.disk.total_bytes)}
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <LoadingIndicator label="Loading" className="py-4" />
        )}
      </Section>

      <Section
        title="Background activity"
        description="Live progress for channel catalog work, AI jobs, and metadata sync. Refresh catalogs indexes new channels and checks ready ones for new uploads; Full reindex re-walks every channel."
        hidden={
          !match(
            "background tasks",
            "background activity",
            "channel catalog",
            "index",
            "queue",
            "ai process",
            "metadata sync",
            "refresh catalogs",
            "full reindex"
          )
        }
      >
        <div className="space-y-4">
          {(appSettings?.channel_catalog_enabled ?? true) && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Channel catalog
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={catalogIndexing}
                    onClick={async () => {
                      if (catalogIndexing) return;
                      setCatalogIndexing(true);
                      try {
                        const result = await api.indexChannelCatalog({
                          mode: "incremental",
                        });
                        showToast(
                          result.detail || "Channel catalogs refreshed"
                        );
                        refreshCatalogStatus();
                      } catch (err) {
                        showToast(
                          err instanceof Error && err.message
                            ? err.message
                            : "Could not refresh channel catalogs"
                        );
                      } finally {
                        setCatalogIndexing(false);
                      }
                    }}
                    className={PANEL_BTN + " !px-2.5 !py-1 !text-xs"}
                  >
                    {catalogIndexing ? "Working…" : "Refresh catalogs"}
                  </button>
                  <button
                    type="button"
                    disabled={catalogIndexing}
                    onClick={async () => {
                      if (catalogIndexing) return;
                      const ok = window.confirm(
                        "Re-walk every channel’s upload list up to the max-videos cap. This can take a long time on large libraries. Continue?"
                      );
                      if (!ok) return;
                      setCatalogIndexing(true);
                      try {
                        const result = await api.indexChannelCatalog({
                          mode: "full",
                        });
                        showToast(
                          result.detail || "Full channel reindex queued"
                        );
                        refreshCatalogStatus();
                      } catch (err) {
                        showToast(
                          err instanceof Error && err.message
                            ? err.message
                            : "Could not start full reindex"
                        );
                      } finally {
                        setCatalogIndexing(false);
                      }
                    }}
                    className={
                      PANEL_BTN +
                      " !px-2.5 !py-1 !text-xs !border-ink-600 !text-gray-400 hover:!text-gray-200"
                    }
                  >
                    Full reindex…
                  </button>
                </div>
              </div>
              {catalogStatus ? (
                <dl className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-400">Queue</dt>
                    <dd className="text-gray-200">
                      {catalogStatus.queue_depth} pending
                      {catalogStatus.running ? " · running" : ""}
                    </dd>
                  </div>
                  {(catalogStatus.current_channel ||
                    catalogStatus.current_channel_url) && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-400">Current</dt>
                      <dd className="truncate text-right text-gray-200">
                        {catalogStatus.current_channel ||
                          catalogStatus.current_channel_url}
                      </dd>
                    </div>
                  )}
                  {catalogStatus.current_phase && (
                    <div className="flex justify-between gap-3">
                      <dt className="text-gray-400">Phase</dt>
                      <dd className="text-gray-200">
                        {catalogStatus.current_phase}
                        {catalogStatus.total > 0
                          ? ` · ${catalogStatus.done}/${catalogStatus.total}`
                          : ""}
                      </dd>
                    </div>
                  )}
                  {catalogStatus.catalogs
                    .filter((c) => c.last_error)
                    .slice(0, 2)
                    .map((c) => (
                      <p
                        key={c.id ?? c.channel_url}
                        className="text-xs text-red-400"
                      >
                        {c.channel_name || c.channel_url}: {c.last_error}
                      </p>
                    ))}
                  {!catalogStatus.running &&
                    catalogStatus.queue_depth === 0 && (
                      <p className="text-xs text-gray-500">
                        Idle
                        {catalogStatus.catalogs.filter(
                          (c) => c.status === "ready"
                        ).length
                          ? ` · ${
                              catalogStatus.catalogs.filter(
                                (c) => c.status === "ready"
                              ).length
                            } channel(s) indexed`
                          : ""}
                      </p>
                    )}
                </dl>
              ) : (
                <p className="text-sm text-gray-500">Loading…</p>
              )}
            </div>
          )}

          {aiStatus && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  AI
                </p>
              </div>
              <AiQueueStatus
                aiStatus={aiStatus}
                systemStats={systemStats}
                compact
                onPause={async () => {
                  await api.pauseAi().catch(() => undefined);
                  await saveAi({ paused: true });
                  showToast("AI queue paused");
                }}
                onResume={async () => {
                  await api.resumeAi().catch(() => undefined);
                  await saveAi({ paused: false });
                  showToast("AI queue resumed");
                }}
              />
            </div>
          )}

          {metadataSyncStatus?.running && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Metadata sync
              </p>
              <p className="text-sm text-gray-300">
                {metadataSyncStatus.done + metadataSyncStatus.failed}/
                {metadataSyncStatus.total}
                {metadataSyncStatus.current_title
                  ? ` — ${metadataSyncStatus.current_title}`
                  : ""}
              </p>
              {metadataSyncStatus.last_error && (
                <p className="mt-1 text-xs text-red-400">
                  {metadataSyncStatus.last_error}
                </p>
              )}
            </div>
          )}
        </div>
      </Section>

      {health?.wiki_available ? (
        <Section
          title="Documentation"
          hidden={
            !match(
              "documentation",
              "docs",
              "wiki",
              "manual",
              "help",
              "guide",
              "api",
              "swagger"
            )
          }
        >
          <p className="mb-3 text-xs text-gray-500">
            Product wiki and interactive API reference for this Horde install.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href="/wiki/"
              target="_blank"
              rel="noreferrer"
              className={PANEL_BTN}
            >
              Wiki
            </a>
            <a
              href="/docs"
              target="_blank"
              rel="noreferrer"
              className={PANEL_BTN}
            >
              API (Swagger)
            </a>
          </div>
        </Section>
      ) : null}
    </>
  );
}
