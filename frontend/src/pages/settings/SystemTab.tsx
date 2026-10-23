import { describeError } from "../../apiErrors";
import { useSettingsPage } from "./context";
import { useAiCore } from "./ai/useAiCore";
import ResetHordePanel from "./system/ResetHordePanel";
import StatusSection from "./system/StatusSection";
import StorageSection from "./system/StorageSection";
import UpdatesSection from "./system/UpdatesSection";
import { useSystemState } from "./useSystemState";
import { Section } from "./ui";
import { PANEL_BTN } from "./constants";
import { api } from "../../api";
import { useConfirm } from "../../context/ConfirmContext";
import AiQueueStatus from "./AiQueueStatus";
import BackgroundActivity from "./BackgroundActivity";
import NotificationsSection from "./NotificationsSection";
import SystemStatsSnippet from "./SystemStatsSnippet";

export default function SystemTab() {
  const confirm = useConfirm();
  const system = useSystemState();
  const ai = useAiCore();
  const { match, showToast, showError } = useSettingsPage();
  const {
    storage,
    health,
    catalogStatus,
    catalogIndexing,
    setCatalogIndexing,
    refreshCatalogStatus,
    systemActivity,
    metadataSyncStatus,
  } = system;
  const {
    aiStatus,
    systemStats,
    openRouterCosts,
    saveAi,
    runAiProcess,
    aiProcessingAction,
    appSettings,
  } = ai;

  return (
    <>
      <UpdatesSection system={system} />

      <StorageSection storage={storage} />

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
        <p className="mb-3 max-w-2xl text-xs text-muted">
          CPU, RAM, and GPU as seen from this Horde process. AI workload sizing
          uses the Ollama machine instead (see AI → Providers).
        </p>
        <SystemStatsSnippet stats={systemStats} />
      </Section>

      <StatusSection system={system} />

      <Section
        title="Background activity"
        description="Live and recent jobs — ffmpeg, downloads, AI, catalog indexing, folder scans — with why each started. Refresh catalogs indexes new channels and checks ready ones for new uploads; Full reindex re-walks every channel."
        hidden={
          !match(
            "background tasks",
            "background activity",
            "ffmpeg",
            "sprites",
            "seek previews",
            "thumbnails",
            "cpu usage",
            "scanner",
            "loudness",
            "normalization",
            "yt-dlp",
            "activity",
            "channel catalog",
            "index",
            "queue",
            "ai process",
            "metadata sync",
            "refresh catalogs",
            "full reindex",
            "gpu jobs",
            "index missing"
          )
        }
      >
        <div className="space-y-4">
          <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
            <BackgroundActivity activity={systemActivity} />
          </div>

          {(appSettings?.channel_catalog_enabled ?? true) && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
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
                    className={PANEL_BTN + " px-2.5! py-1! text-xs!"}
                  >
                    {catalogIndexing ? "Working…" : "Refresh catalogs"}
                  </button>
                  <button
                    type="button"
                    disabled={catalogIndexing}
                    onClick={async () => {
                      if (catalogIndexing) return;
                      const ok = await confirm({
                        title: "Full channel reindex?",
                        body: "Re-walk every channel’s upload list up to the max-videos cap. This can take a long time on large libraries.",
                        confirmLabel: "Reindex",
                      });
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
                      " px-2.5! py-1! text-xs! border-ink-600! text-gray-400! hover:text-gray-200!"
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
                      <p className="text-xs text-muted">
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
                <p className="text-sm text-muted">Loading…</p>
              )}
            </div>
          )}

          {aiStatus && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">
                  AI
                </p>
              </div>
              <AiQueueStatus
                aiStatus={aiStatus}
                systemStats={systemStats}
                openRouterCosts={openRouterCosts}
                compact
                onPause={async () => {
                  try {
                    await api.pauseAi();
                  } catch (err) {
                    showError(
                      `Could not pause AI queue: ${describeError(err)}`
                    );
                    return;
                  }
                  await saveAi({ paused: true });
                  showToast("AI queue paused");
                }}
                onResume={async () => {
                  try {
                    await api.resumeAi();
                  } catch (err) {
                    showError(
                      `Could not resume AI queue: ${describeError(err)}`
                    );
                    return;
                  }
                  await saveAi({ paused: false });
                  showToast("AI queue resumed");
                }}
                onIndexMissing={() => runAiProcess("embeds")}
                indexBusy={aiProcessingAction === "embeds"}
              />
            </div>
          )}

          {metadataSyncStatus?.running && (
            <div className="rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
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

      <NotificationsSection />

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
          <p className="mb-3 text-xs text-muted">
            Product wiki and interactive API reference for Horde.
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

      <Section
        title="Reset Horde"
        hidden={!match("reset", "factory", "wipe", "erase", "setup wizard")}
      >
        <ResetHordePanel storage={storage} health={health} />
      </Section>
    </>
  );
}
