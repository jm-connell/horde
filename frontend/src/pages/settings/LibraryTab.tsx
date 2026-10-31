import { useAuth } from "../../context/AuthContext";
import { useHelpChat } from "../../context/HelpChatContext";
import { useSettingsPage } from "./context";
import { useLibraryState } from "./useLibraryState";
import { Section, SettingRow, Toggle, Chip } from "./ui";
import {
  CATALOG_INDEX_TIP,
  CATALOG_MAX_TIP,
  CHANNEL_SORT_OPTIONS,
  DIRECT_YOUTUBE_SEARCH_TIP,
  YOUTUBE_VIDEO_SEARCH_TIP,
  DISCOVERY_TIP,
  INPUT_COMPACT,
  MEDIA_SERVER_TERMS,
  METADATA_INTERVAL_TIP,
  PANEL_BTN,
} from "./constants";
import {
  LIBRARY_SORT_OPTIONS,
  type LibrarySort,
} from "../../hooks/useLibrarySort";
import HelpTip from "../../components/HelpTip";
import FollowedChannelsSection from "./FollowedChannelsSection";
import HelpDataSection from "./HelpDataSection";
import MediaServerFiles from "./MediaServerFiles";
import PlaybackCompatPicker from "./PlaybackCompatPicker";
import TrashSection from "./TrashSection";
import YoutubeHistorySection from "./YoutubeHistorySection";

const EXPIRY_TERMS = ["progress expiry", "inactivity", "days"];

const YOUTUBE_HISTORY_TERMS = [
  "youtube history",
  "google takeout",
  "takeout",
  "import",
  "subscriptions",
  "watch history",
  "history stats",
];

const HELP_DATA_TERMS = [
  "use my data",
  "ask about horde",
  "assistant",
  "chat",
  "privacy",
  "consent",
];

const DOWNLOAD_PREF_TERMS = [
  "download count",
  "navigation",
  "badge",
  "normalize volume",
  "loudness",
  "downloads",
];

const COMPAT_TERMS = [
  "compatibility",
  "av1",
  "h264",
  "h265",
  "hevc",
  "codec",
  "transcode",
  "sidecar",
  "gpu",
  "nvenc",
  "playback compatibility",
  "convert",
];

export default function LibraryTab() {
  const { q, match, settings, update } = useSettingsPage();
  const { isAdmin, can } = useAuth();
  const helpChat = useHelpChat();
  // Download preferences only matter to someone who may download (admins can).
  const canDownload = can("download");
  const {
    appSettings,
    catalogMaxInput,
    setCatalogMaxInput,
    syncIntervalInput,
    setSyncIntervalInput,
    saveCatalogSettings,
    saveMediaSidecars,
    removeMediaSidecars,
    metadataSyncFields,
    toggleSyncField,
    resyncAllMetadata,
    metadataSyncing,
    metadataSyncStatus,
    expiryInput,
    setExpiryInput,
    saveExpiry,
    systemStats,
  } = useLibraryState();

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
            "live streams",
            "followed channels",
            "follow",
            "progress bar",
            "dates",
            "video cards",
            ...(isAdmin ? EXPIRY_TERMS : []),
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
            anchor="show-continue-watching"
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
            anchor="show-live-streams"
            title="Show live streams"
            description="List followed channels that are live in the library sidebar."
            hidden={!!q && !match("live streams", "live", "follow")}
            control={
              <Toggle
                checked={settings.showLiveStreams}
                onChange={() =>
                  update({ showLiveStreams: !settings.showLiveStreams })
                }
              />
            }
          />
          <div hidden={!!q && !match("followed channels", "follow", "live")}>
            <FollowedChannelsSection />
          </div>
          <SettingRow
            anchor="progress-continue-watching"
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
            anchor="progress-all-videos"
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
            anchor="card-dates"
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

        {/* Server-wide: it resets everyone's saved positions. */}
        {isAdmin && (
          <div
            data-setting="progress-expiry"
            className="mt-6 border-t border-ink-700 pt-6"
          >
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              Progress expiry
            </h3>
            <p className="mb-3 text-xs text-muted">
              Saved watch position resets after this many days of inactivity.
              The continue watching row hides videos after 7 days (fixed, not
              configurable).
            </p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={365}
                aria-label="Progress expiry in days"
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
        )}

        <div
          data-setting="default-sort"
          className="mt-6 border-t border-ink-700 pt-6"
        >
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
            Default video sort
          </h3>
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

        <div
          data-setting="channel-sort"
          className="mt-6 border-t border-ink-700 pt-6"
        >
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
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
        anchor="youtube-history"
        title="YouTube history"
        description="Import your watch history, subscriptions and playlists from Google Takeout. Only your account sees them."
        hidden={!match(...YOUTUBE_HISTORY_TERMS)}
      >
        <YoutubeHistorySection />
      </Section>

      <Section
        anchor="help-data"
        title="Ask about Horde: use my data"
        description="Let Ask about Horde answer about your own downloads, library, watch history and playlists. Only questions about your own things send any, and only what the question needs."
        hidden={!helpChat.available || !match(...HELP_DATA_TERMS)}
      >
        <HelpDataSection />
      </Section>

      <Section
        anchor="downloads"
        title="Downloads"
        hidden={
          !canDownload ||
          !match(...DOWNLOAD_PREF_TERMS, ...(isAdmin ? COMPAT_TERMS : []))
        }
      >
        <div className="space-y-4">
          <SettingRow
            anchor="download-badge"
            title="Show active download count in navigation"
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
            anchor="normalize-volume"
            title="Normalize volume on download"
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
          {/* Server-wide: the codec every download uses and the library's H.264 copies. */}
          {isAdmin && (
            <div hidden={!!q && !match(...COMPAT_TERMS)}>
              <PlaybackCompatPicker
                mode={settings.downloadVideoCodec}
                onChange={(id) => update({ downloadVideoCodec: id })}
                copyResolution={settings.compatCopyResolution}
                onCopyResolutionChange={(v) =>
                  update({ compatCopyResolution: v })
                }
                stats={systemStats}
                showLibraryActions
              />
            </div>
          )}
        </div>
      </Section>

      <Section
        anchor="metadata"
        title="Metadata and catalog"
        hidden={
          !isAdmin ||
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
            "youtube",
            "direct youtube search",
            "youtube video search",
            "channel search",
            "library search",
            ...MEDIA_SERVER_TERMS
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
          <SettingRow
            anchor="youtube-channel-search"
            title="YouTube results in channel search"
            description="A channel’s search box also finds that channel’s uploads on YouTube that are not indexed yet."
            control={
              <div className="flex items-center gap-2">
                <HelpTip text={DIRECT_YOUTUBE_SEARCH_TIP} />
                <Toggle
                  checked={appSettings?.direct_youtube_search ?? true}
                  onChange={() =>
                    void saveCatalogSettings({
                      direct_youtube_search: !(
                        appSettings?.direct_youtube_search ?? true
                      ),
                    })
                  }
                />
              </div>
            }
          />
          <SettingRow
            anchor="youtube-library-search"
            title="YouTube results in library search"
            description="The main search bar also shows matching videos from all of YouTube."
            control={
              <div className="flex items-center gap-2">
                <HelpTip text={YOUTUBE_VIDEO_SEARCH_TIP} />
                <Toggle
                  checked={appSettings?.youtube_video_search ?? true}
                  onChange={() =>
                    void saveCatalogSettings({
                      youtube_video_search: !(
                        appSettings?.youtube_video_search ?? true
                      ),
                    })
                  }
                />
              </div>
            }
          />
          <SettingRow
            anchor="discovery"
            title="Recommended+ looks on YouTube"
            description="Recommended+ searches YouTube for videos and channels new to each person, built from what they watch. Needs YouTube results in library search."
            control={
              <div className="flex items-center gap-2">
                <HelpTip text={DISCOVERY_TIP} />
                <Toggle
                  checked={appSettings?.discovery_enabled ?? true}
                  onChange={() =>
                    void saveCatalogSettings({
                      discovery_enabled: !(
                        appSettings?.discovery_enabled ?? true
                      ),
                    })
                  }
                />
              </div>
            }
          />
          <SettingRow
            anchor="discovery-household"
            title="Recommendations learn from the household"
            description="Recommended+ gives a small lift to library videos that people here with similar taste liked. It never says who watched what."
            control={
              <Toggle
                checked={appSettings?.discovery_household ?? true}
                onChange={() =>
                  void saveCatalogSettings({
                    discovery_household: !(
                      appSettings?.discovery_household ?? true
                    ),
                  })
                }
              />
            }
          />
          <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="settings-catalog-max"
                className="mb-1 flex items-center gap-1.5 text-xs text-muted"
              >
                Max indexed videos per channel
                <HelpTip text={CATALOG_MAX_TIP} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="settings-catalog-max"
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
                      clamped !==
                      (appSettings?.channel_catalog_max_videos ?? 1000)
                    ) {
                      void saveCatalogSettings({
                        channel_catalog_max_videos: clamped,
                      });
                    }
                  }}
                  className={INPUT_COMPACT}
                />
                <span className="text-xs text-muted">100–5000</span>
              </div>
              {parseInt(catalogMaxInput, 10) > 1000 && (
                <p className="mt-1.5 text-xs text-warning">
                  Large indexes can take a long time and may slow other YouTube
                  work while running.
                </p>
              )}
            </div>
            <div>
              <label
                htmlFor="settings-metadata-interval"
                className="mb-1 flex items-center gap-1.5 text-xs text-muted"
              >
                Refresh interval (hours)
                <HelpTip text={METADATA_INTERVAL_TIP} />
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="settings-metadata-interval"
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
              className="py-1.5!"
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
              <p className="mt-1 text-danger">
                {metadataSyncStatus.last_error}
              </p>
            )}
          </div>
        )}
        <div hidden={!!q && !match(...MEDIA_SERVER_TERMS)}>
          <MediaServerFiles
            enabled={appSettings?.media_server_sidecars ?? false}
            onToggle={(on) => void saveMediaSidecars(on)}
            onRemove={() => void removeMediaSidecars()}
          />
        </div>
      </Section>

      <TrashSection />
    </>
  );
}
