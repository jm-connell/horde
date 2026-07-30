import { useSettingsPage } from "./context";
import { Section, SettingRow, Toggle, Chip } from "./ui";
import {
  CATALOG_INDEX_TIP,
  CATALOG_MAX_TIP,
  CHANNEL_SORT_OPTIONS,
  INPUT_COMPACT,
  METADATA_INTERVAL_TIP,
  PANEL_BTN,
} from "./constants";
import { LIBRARY_SORT_OPTIONS, type LibrarySort } from "../../hooks/useLibrarySort";
import HelpTip from "../../components/HelpTip";

export default function LibraryTab() {
  const {
    q,
    match,
    settings,
    update,
    appSettings,
    catalogMaxInput,
    setCatalogMaxInput,
    syncIntervalInput,
    setSyncIntervalInput,
    saveCatalogSettings,
    metadataSyncFields,
    toggleSyncField,
    resyncAllMetadata,
    metadataSyncing,
    metadataSyncStatus,
    expiryInput,
    setExpiryInput,
    saveExpiry,
  } = useSettingsPage();

  return (
    <>
      <Section
        first
        title="Display"
        description="Homepage, cards, and sorting."
        hidden={
          !match(
            "homepage",
            "continue watching",
            "progress bar",
            "dates",
            "video cards",
            "progress expiry",
            "inactivity",
            "days",
            "default video sort",
            "sort",
            "library",
            "channel list order",
            "sidebar",
            "ascending",
            "descending"
          )
        }
      >
        <div className="space-y-4">
          <SettingRow
            title="Show continue watching"
            description="Display the continue watching row on the library home page."
            hidden={!!q && !match("continue watching", "homepage")}
            control={
              <Toggle
                checked={settings.showContinueWatching}
                onChange={() =>
                  update({
                    showContinueWatching: !settings.showContinueWatching,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Progress bar on continue watching"
            description="Show watch progress on cards in the continue watching row."
            hidden={!!q && !match("progress bar", "continue watching")}
            control={
              <Toggle
                checked={settings.showProgressOnContinueWatching}
                onChange={() =>
                  update({
                    showProgressOnContinueWatching:
                      !settings.showProgressOnContinueWatching,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Progress bar on all library videos"
            description="Show watch progress on every card in the main library grid."
            hidden={!!q && !match("progress bar", "library videos")}
            control={
              <Toggle
                checked={settings.showProgressOnAllVideos}
                onChange={() =>
                  update({
                    showProgressOnAllVideos: !settings.showProgressOnAllVideos,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Show dates on video cards"
            description="Display the published date (e.g. May 14, 2023) on library cards."
            hidden={!!q && !match("dates", "video cards")}
            control={
              <Toggle
                checked={settings.showCardDates}
                onChange={() =>
                  update({ showCardDates: !settings.showCardDates })
                }
              />
            }
          />
        </div>

        <div className="mt-6 border-t border-ink-700 pt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Progress expiry
          </h3>
          <p className="mb-3 text-xs text-gray-500">
            Saved watch position resets after this many days of inactivity.
            The continue watching row hides videos after 7 days (fixed, not
            configurable).
          </p>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              max={365}
              value={expiryInput}
              onChange={(e) => setExpiryInput(e.target.value)}
              className={INPUT_COMPACT}
            />
            <button
              onClick={saveExpiry}
              disabled={
                !appSettings ||
                parseInt(expiryInput, 10) === appSettings.progress_expiry_days
              }
              className={PANEL_BTN}
            >
              Save
            </button>
          </div>
        </div>

        <div className="mt-6 border-t border-ink-700 pt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Default video sort
          </h3>
          <p className="mb-3 text-xs text-gray-500">
            Used when you open the library or after a temporary sort expires
            (3 hours).
          </p>
          <div className="flex flex-wrap gap-2">
            {LIBRARY_SORT_OPTIONS.filter((o) => o.value !== "random").map(
              (opt) => (
                <Chip
                  key={opt.value}
                  active={settings.defaultLibrarySort === opt.value}
                  onClick={() =>
                    update({ defaultLibrarySort: opt.value as LibrarySort })
                  }
                >
                  {opt.label}
                </Chip>
              )
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-ink-700 pt-6">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Channel list order (sidebar)
          </h3>
          <div className="mb-3 flex flex-wrap gap-2">
            {CHANNEL_SORT_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={settings.channelSort === opt.value}
                onClick={() => update({ channelSort: opt.value })}
              >
                {opt.label}
              </Chip>
            ))}
          </div>
          <div className="flex gap-2">
            {(["desc", "asc"] as const).map((dir) => (
              <Chip
                key={dir}
                active={settings.channelOrder === dir}
                onClick={() => update({ channelOrder: dir })}
              >
                {dir === "desc" ? "Descending" : "Ascending"}
              </Chip>
            ))}
          </div>
        </div>
      </Section>

      <Section
        title="Downloads"
        description="Background download queue and navigation preferences."
        hidden={
          !match(
            "download count",
            "navigation",
            "badge",
            "normalize volume",
            "loudness",
            "downloads"
          )
        }
      >
        <div className="space-y-4">
          <SettingRow
            title="Show active download count in navigation"
            description="Badge on the Download tab while jobs are queued or in progress."
            hidden={!!q && !match("download count", "navigation", "badge")}
            control={
              <Toggle
                checked={settings.showDownloadNavBadge}
                onChange={() =>
                  update({
                    showDownloadNavBadge: !settings.showDownloadNavBadge,
                  })
                }
              />
            }
          />
          <SettingRow
            title="Normalize volume on download"
            description="Apply loudness normalization when saving new videos (requires ffmpeg)."
            hidden={!!q && !match("normalize volume", "loudness")}
            control={
              <Toggle
                checked={settings.normalizeVolumeOnDownload}
                onChange={() =>
                  update({
                    normalizeVolumeOnDownload:
                      !settings.normalizeVolumeOnDownload,
                  })
                }
              />
            }
          />
        </div>
      </Section>

      <Section
        title="Metadata and catalog"
        description="Pull fresh thumbnails, captions, view counts, and titles from each video's source URL. Choose what to sync. Channel catalogs refresh on the same interval."
        hidden={
          !match(
            "library metadata",
            "resync",
            "thumbnails",
            "captions",
            "view counts",
            "channel catalog",
            "index",
            "refresh interval",
            "youtube only",
            "youtube"
          )
        }
      >
        <div className="mb-4 space-y-4">
          <SettingRow
            title="Index channel libraries"
            description="YouTube only — background-index uploads when you download from a channel or open its feed, so feed search works beyond the loaded page."
            control={
              <div className="flex items-center gap-2">
                <HelpTip text={CATALOG_INDEX_TIP} />
                <Toggle
                  checked={appSettings?.channel_catalog_enabled ?? true}
                  onChange={() =>
                    void saveCatalogSettings({
                      channel_catalog_enabled: !(
                        appSettings?.channel_catalog_enabled ?? true
                      ),
                    })
                  }
                />
              </div>
            }
          />
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
              Max videos per channel
              <HelpTip text={CATALOG_MAX_TIP} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={100}
                max={5000}
                step={100}
                value={catalogMaxInput}
                onChange={(e) => setCatalogMaxInput(e.target.value)}
                onBlur={() => {
                  const n = parseInt(catalogMaxInput, 10);
                  if (isNaN(n)) {
                    setCatalogMaxInput(
                      String(appSettings?.channel_catalog_max_videos ?? 1000)
                    );
                    return;
                  }
                  const clamped = Math.max(100, Math.min(5000, n));
                  setCatalogMaxInput(String(clamped));
                  if (
                    clamped !== (appSettings?.channel_catalog_max_videos ?? 1000)
                  ) {
                    void saveCatalogSettings({
                      channel_catalog_max_videos: clamped,
                    });
                  }
                }}
                className={INPUT_COMPACT}
              />
              <span className="text-xs text-gray-500">100–5000</span>
            </div>
            {parseInt(catalogMaxInput, 10) > 1000 && (
              <p className="mt-1.5 text-xs text-amber-400/90">
                Large indexes can take a long time and may slow other YouTube
                work while running.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
              Metadata / catalog refresh interval (hours)
              <HelpTip text={METADATA_INTERVAL_TIP} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                min={1}
                max={168}
                value={syncIntervalInput}
                onChange={(e) => setSyncIntervalInput(e.target.value)}
                onBlur={() => {
                  const n = parseInt(syncIntervalInput, 10);
                  if (isNaN(n)) {
                    setSyncIntervalInput(
                      String(appSettings?.metadata_sync_interval_hours ?? 24)
                    );
                    return;
                  }
                  const clamped = Math.max(1, Math.min(168, n));
                  setSyncIntervalInput(String(clamped));
                  if (
                    clamped !==
                    (appSettings?.metadata_sync_interval_hours ?? 24)
                  ) {
                    void saveCatalogSettings({
                      metadata_sync_interval_hours: clamped,
                    });
                  }
                }}
                className={INPUT_COMPACT}
              />
            </div>
          </div>
        </div>
        <div className="mb-3 flex flex-wrap gap-2">
          {(
            [
              ["all", "Everything"],
              ["views", "Views"],
              ["thumbnails", "Thumbnails"],
              ["captions", "Captions"],
              ["titles_descriptions", "Titles & descriptions"],
            ] as const
          ).map(([value, label]) => (
            <Chip
              key={value}
              active={
                value === "all"
                  ? metadataSyncFields.includes("all")
                  : metadataSyncFields.includes(value) &&
                    !metadataSyncFields.includes("all")
              }
              onClick={() => toggleSyncField(value)}
              className="!py-1.5"
            >
              {label}
            </Chip>
          ))}
        </div>
        <button
          onClick={resyncAllMetadata}
          disabled={metadataSyncing}
          className={PANEL_BTN}
        >
          {metadataSyncing ? "Syncing…" : "Resync metadata"}
        </button>
        {metadataSyncing && metadataSyncStatus && (
          <div className="mt-3 rounded-lg border border-ink-700 bg-ink-950/60 px-3 py-2 text-xs text-gray-400">
            <p>
              {metadataSyncStatus.done + metadataSyncStatus.failed}/
              {metadataSyncStatus.total}
              {metadataSyncStatus.current_title
                ? ` — ${metadataSyncStatus.current_title}`
                : ""}
            </p>
            {metadataSyncStatus.last_error && (
              <p className="mt-1 text-red-400">
                {metadataSyncStatus.last_error}
              </p>
            )}
          </div>
        )}
      </Section>
    </>
  );
}
