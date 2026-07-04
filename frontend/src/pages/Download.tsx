import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useDownloads, isActiveJob } from "../context/DownloadContext";
import { useSettings } from "../hooks/useSettings";
import ChannelPicker from "../components/ChannelPicker";
import DownloadJobCard from "../components/DownloadJobCard";
import {
  formatApproxSize,
  mergePinnedPreset,
  PRESET_ORDER,
  presetOptionLabel,
} from "../presets";
import type { ChannelStat, DownloadPreview, PlaylistPreviewEntry } from "../types";
import { formatDuration, formatViewCount } from "../utils";

const ACTIVE_COLLAPSE_KEY = "horde.downloads.active-collapsed";

export default function Download() {
  const {
    jobs,
    progress,
    activeCount,
    queuePaused,
    submitDownload,
    pauseQueue,
    resumeQueue,
    dismissFinishedJobs,
  } = useDownloads();
  const [settings] = useSettings();

  const [url, setUrl] = useState("");
  const [preset, setPreset] = useState("best");
  const [allPresets, setAllPresets] = useState<string[]>([...PRESET_ORDER]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<DownloadPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState("");
  const [channels, setChannels] = useState<ChannelStat[]>([]);

  const [importMessage, setImportMessage] = useState<string | null>(null);

  const [playlistEntries, setPlaylistEntries] = useState<PlaylistPreviewEntry[]>(
    []
  );
  const [playlistName, setPlaylistName] = useState("");
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [playlistSizes, setPlaylistSizes] = useState<
    Record<string, Record<string, number>>
  >({});
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);

  const [activeCollapsed, setActiveCollapsed] = useState(() => {
    try {
      return localStorage.getItem(ACTIVE_COLLAPSE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (activeCount > 0 && activeCollapsed) {
      setActiveCollapsed(false);
    }
  }, [activeCount]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleActiveCollapsed = () => {
    setActiveCollapsed((v) => {
      const next = !v;
      localStorage.setItem(ACTIVE_COLLAPSE_KEY, String(next));
      return next;
    });
  };

  useEffect(() => {
    api.listPresets().then(setAllPresets).catch(() => undefined);
    api.listChannels().then(setChannels).catch(() => undefined);
  }, []);

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setPreview(null);
      setPreset("best");
      return;
    }
    setPreviewing(true);
    const id = setTimeout(() => {
      api
        .previewDownload(trimmed)
        .then((p) => {
          setPreview(p);
          setTitle(p.title ?? "");
          setChannel(p.channel ?? "");
          if (!p.is_playlist && p.available_presets.length > 0) {
            setPreset((current) =>
              current !== "best" ? current : p.available_presets[0]
            );
          }
        })
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 600);
    return () => {
      clearTimeout(id);
      setPreviewing(false);
    };
  }, [url]);

  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed || !preview?.is_playlist) {
      setPlaylistEntries([]);
      setPlaylistName("");
      setSelectedUrls(new Set());
      setPlaylistSizes({});
      return;
    }
    setLoadingPlaylist(true);
    api
      .previewPlaylist(trimmed)
      .then((data) => {
        setPlaylistEntries(data.entries);
        setPlaylistName(data.title ?? "");
        setSelectedUrls(new Set(data.entries.map((e) => e.url)));
      })
      .catch(() => {
        setPlaylistEntries([]);
        setSelectedUrls(new Set());
      })
      .finally(() => setLoadingPlaylist(false));
  }, [url, preview?.is_playlist]);

  useEffect(() => {
    if (!preview?.is_playlist || playlistEntries.length === 0) {
      setPlaylistSizes({});
      return;
    }
    let cancelled = false;
    api
      .estimatePlaylistSizes(playlistEntries.map((e) => e.url))
      .then((result) => {
        if (!cancelled) setPlaylistSizes(result.sizes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [preview?.is_playlist, playlistEntries]);

  const metadataLoaded =
    preview != null && !preview.is_playlist && preview.available_presets.length > 0;

  const qualityOptions = useMemo(() => {
    if (!metadataLoaded) return allPresets;
    return mergePinnedPreset(preview!.available_presets, preset);
  }, [metadataLoaded, preview, preset, allPresets]);

  const isPlaylist = preview?.is_playlist ?? false;
  const presetSizes = preview?.preset_sizes;
  const selectedPresetSize = presetSizes?.[preset];

  const downloadButtonLabel = useMemo(() => {
    if (submitting) return "Starting...";
    const approx = formatApproxSize(selectedPresetSize);
    return approx ? `Download (${approx})` : "Download";
  }, [submitting, selectedPresetSize]);

  const playlistTotalSize = useMemo(() => {
    if (!isPlaylist || selectedUrls.size === 0) return undefined;
    let total = 0;
    let any = false;
    for (const entryUrl of selectedUrls) {
      const bytes = playlistSizes[entryUrl]?.[preset];
      if (bytes) {
        total += bytes;
        any = true;
      }
    }
    return any ? total : undefined;
  }, [isPlaylist, selectedUrls, playlistSizes, preset]);

  const importButtonLabel = useMemo(() => {
    if (submitting) return "Starting...";
    const count = selectedUrls.size;
    const approx = formatApproxSize(playlistTotalSize);
    const base =
      count === 0
        ? "Download"
        : `Download ${count} video${count === 1 ? "" : "s"}`;
    return approx ? `${base} (${approx})` : base;
  }, [submitting, selectedUrls.size, playlistTotalSize]);

  const allPlaylistSelected =
    playlistEntries.length > 0 && selectedUrls.size === playlistEntries.length;

  const togglePlaylistEntry = (entryUrl: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(entryUrl)) next.delete(entryUrl);
      else next.add(entryUrl);
      return next;
    });
  };

  const toggleAllPlaylistEntries = () => {
    if (allPlaylistSelected) {
      setSelectedUrls(new Set());
    } else {
      setSelectedUrls(new Set(playlistEntries.map((e) => e.url)));
    }
  };

  const { activeJobs, recentJobs } = useMemo(() => {
    const active: typeof jobs = [];
    const recent: typeof jobs = [];
    for (const job of jobs) {
      if (isActiveJob(job, progress[job.id])) {
        active.push(job);
      } else {
        recent.push(job);
      }
    }
    return { activeJobs: active, recentJobs: recent };
  }, [jobs, progress]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const detectedTitle = (preview?.title ?? "").trim();
      const detectedChannel = (preview?.channel ?? "").trim();
      const t = title.trim();
      const c = channel.trim();
      await submitDownload(url.trim(), preset, {
        title: t && t !== detectedTitle ? t : undefined,
        channel: c && c !== detectedChannel ? c : undefined,
      });
      setUrl("");
      setPreview(null);
      setTitle("");
      setChannel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setSubmitting(false);
    }
  };

  const importAll = async () => {
    const selected = [...selectedUrls];
    if (!url.trim() || selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    setImportMessage(null);
    try {
      const created = await api.importPlaylist(url.trim(), preset, {
        name: playlistName.trim() || undefined,
        entries: selected,
      });
      setImportMessage(
        `Importing "${created.name}" — videos will appear in your library as they finish.`
      );
      setUrl("");
      setPreview(null);
      setPlaylistEntries([]);
      setSelectedUrls(new Set());
      setPlaylistName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Download</h1>
      <p className="mb-6 text-sm text-gray-400">
        Paste a YouTube or other supported link. Adjust the title and channel
        before downloading if you like. Downloads continue in the background and
        appear below.
      </p>

      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700"
      >
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-300">
            Video URL
            <span className="group relative inline-flex">
              <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-ink-700 text-[10px] font-bold text-gray-300">
                ?
              </span>
              <span className="pointer-events-none absolute left-1/2 top-6 z-10 w-64 -translate-x-1/2 rounded-lg bg-ink-800 p-3 text-xs font-normal leading-relaxed text-gray-300 opacity-0 ring-1 ring-ink-600 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                Works with YouTube, Vimeo, Twitch, TikTok, Twitter/X, Dailymotion,
                SoundCloud, and{" "}
                <a
                  href="https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                >
                  1000+ other sites
                </a>{" "}
                supported by yt-dlp.
              </span>
            </span>
          </label>
          <div className="flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Video or playlist URL (YouTube, etc.)"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
            />
            <button
              type="button"
              onClick={() => {
                navigator.clipboard
                  .readText()
                  .then((text) => {
                    if (text.trim()) setUrl(text.trim());
                  })
                  .catch(() => undefined);
              }}
              className="shrink-0 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2.5 text-sm text-gray-300 hover:border-accent hover:text-accent"
            >
              Paste
            </button>
          </div>
          {previewing && (
            <p className="mt-1 text-xs text-gray-500">Reading link...</p>
          )}
        </div>

        {!isPlaylist && (
          <>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Title
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-detected from the link"
                className="w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Channel
              </label>
              <ChannelPicker
                value={channel}
                onChange={setChannel}
                channels={channels}
                placeholder={settings.lastCustomChannel || "Detected channel"}
              />
            </div>
          </>
        )}

        {preview && isPlaylist && (
          <div className="space-y-4 rounded-lg border border-accent/30 bg-accent/5 p-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                Playlist name
              </label>
              <input
                value={playlistName}
                onChange={(e) => setPlaylistName(e.target.value)}
                placeholder="Playlist name"
                className="w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
              />
            </div>

            {loadingPlaylist ? (
              <p className="text-xs text-gray-500">Loading playlist...</p>
            ) : playlistEntries.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-gray-300">
                    {selectedUrls.size} of {playlistEntries.length} selected
                  </p>
                  <button
                    type="button"
                    onClick={toggleAllPlaylistEntries}
                    className="text-xs text-accent hover:underline"
                  >
                    {allPlaylistSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
                <div className="max-h-80 space-y-2 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950/50 p-2">
                  {playlistEntries.map((entry) => (
                    <label
                      key={entry.url}
                      className="flex cursor-pointer items-start gap-3 rounded-lg p-2 hover:bg-ink-900"
                    >
                      <input
                        type="checkbox"
                        checked={selectedUrls.has(entry.url)}
                        onChange={() => togglePlaylistEntry(entry.url)}
                        className="mt-1 shrink-0 accent-accent"
                      />
                      <div className="h-14 w-24 shrink-0 overflow-hidden rounded bg-ink-800">
                        {entry.thumbnail_url ? (
                          <img
                            src={entry.thumbnail_url}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-xs text-gray-600">
                            No preview
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="line-clamp-2 text-sm text-gray-200">
                          {entry.title ?? "Untitled"}
                        </p>
                        <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-gray-500">
                          {entry.channel && <span>{entry.channel}</span>}
                          {entry.view_count != null && (
                            <span>{formatViewCount(entry.view_count)}</span>
                          )}
                          {entry.duration != null && (
                            <span>{formatDuration(entry.duration)}</span>
                          )}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-gray-400">
                {preview.entry_count ?? 0} video
                {preview.entry_count === 1 ? "" : "s"} detected.
              </p>
            )}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">
            Quality
          </label>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-gray-100 outline-none focus:border-accent"
          >
            {qualityOptions.map((p) => (
              <option key={p} value={p}>
                {presetOptionLabel(p, metadataLoaded ? presetSizes : undefined)}
              </option>
            ))}
          </select>
        </div>

        {isPlaylist ? (
          <button
            type="button"
            onClick={importAll}
            disabled={submitting || !url.trim() || selectedUrls.size === 0}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importButtonLabel}
          </button>
        ) : (
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting..." : downloadButtonLabel}
          </button>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {importMessage && <p className="text-sm text-accent">{importMessage}</p>}
      </form>

      {activeCount > 0 && (
        <section className="mt-6 rounded-xl bg-accent/5 p-4 ring-1 ring-accent/40">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={toggleActiveCollapsed}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              <span className="text-gray-400">{activeCollapsed ? "▶" : "▼"}</span>
              <span className="text-sm font-semibold text-gray-100">
                Active downloads
              </span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-ink-950">
                {activeCount}
              </span>
            </button>
            <div className="flex shrink-0 gap-2">
              {queuePaused ? (
                <button
                  type="button"
                  onClick={() => resumeQueue()}
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-soft"
                >
                  Resume all
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => pauseQueue()}
                  className="rounded-lg bg-ink-800 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-700"
                >
                  Pause all
                </button>
              )}
            </div>
          </div>
          <p className="mb-3 text-xs text-gray-400">
            {activeCount} active -
            Pause all stops every download; nothing new starts until you resume.
          </p>
          {!activeCollapsed && (
            <div className="space-y-4">
              {activeJobs.map((job) => (
                <DownloadJobCard
                  key={job.id}
                  job={job}
                  live={progress[job.id]}
                  channels={channels}
                  active
                />
              ))}
            </div>
          )}
        </section>
      )}

      {jobs.length > 0 && activeCount === 0 && recentJobs.length === 0 && (
        <div className="mt-6 space-y-4">
          {jobs.map((job) => (
            <DownloadJobCard
              key={job.id}
              job={job}
              live={progress[job.id]}
              channels={channels}
              active={isActiveJob(job, progress[job.id])}
            />
          ))}
        </div>
      )}

      {recentJobs.length > 0 && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-gray-400">
              Recent downloads
            </h2>
            {recentJobs.some((j) => j.status === "completed" || j.status === "error") && (
              <button
                type="button"
                onClick={dismissFinishedJobs}
                className="text-xs text-gray-500 hover:text-accent"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="space-y-4">
            {recentJobs.map((job) => (
              <DownloadJobCard
                key={job.id}
                job={job}
                live={progress[job.id]}
                channels={channels}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
