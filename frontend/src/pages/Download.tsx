import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { useDownloads, isActiveJob } from "../context/DownloadContext";
import ChannelPicker from "../components/ChannelPicker";
import Collapse from "../components/Collapse";
import DownloadJobCard from "../components/DownloadJobCard";
import LoadingIndicator from "../components/LoadingIndicator";
import SendLinksHelp from "../components/SendLinksHelp";
import ThemedSelect from "../components/ThemedSelect";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { sharedUrlFromParams } from "../shareTarget";
import { downloadErrorHint, downloadErrorLabel } from "../downloadErrors";
import {
  formatApproxSize,
  mergePinnedPreset,
  PRESET_ORDER,
  presetOptionLabel,
} from "../presets";
import type {
  ChannelStat,
  DownloadBulkSkip,
  DownloadDestination,
  DownloadPreview,
  PlaylistPreviewEntry,
} from "../types";
import {
  clipboardEventToText,
  clipboardReadAvailable,
  clipboardTextToUrl,
  execPasteInto,
  insecureClipboardHint,
  isYoutubePlaylistOnlyUrl,
  isYoutubeShortsUrl,
  parseDownloadUrlList,
  pasteTextFromButtonClick,
  readClipboardText,
  shouldCapturePagePaste,
} from "../clipboard";

import { getItem, setItem } from "../storage";
import PlaylistEntryList from "./download/PlaylistEntryList";
import PlaylistModePicker from "./download/PlaylistModePicker";
import { toastBulkSkips } from "./download/skips";

const ACTIVE_COLLAPSE_KEY = "horde.downloads.active-collapsed";

export default function Download() {
  const { showToast } = useToast();
  // Pausing the queue stops everyone's downloads: an administrator's call.
  const { isAdmin } = useAuth();
  const {
    jobs,
    progress,
    activeCount,
    queuePaused,
    queueHeldReason,
    submitDownload,
    submitBulkDownloads,
    pauseQueue,
    resumeQueue,
    dismissFinishedJobs,
    refreshJobs,
  } = useDownloads();

  const [url, setUrl] = useState("");
  const location = useLocation();
  const navigate = useNavigate();

  // A link sent from the share sheet, the bookmarklet or an iOS Shortcut
  // (`/download?url=...`): fill the field so the usual link lookup runs, but
  // never queue it; that stays the user's click. Then drop the parameters so
  // a reload does not redo it.
  useEffect(() => {
    if (!location.search) return;
    const shared = sharedUrlFromParams(new URLSearchParams(location.search));
    if (shared) setUrl(shared);
    navigate(location.pathname, { replace: true });
  }, [location.pathname, location.search, navigate]);
  const [pasteHint, setPasteHint] = useState("");
  const urlInputRef = useRef<HTMLInputElement>(null);
  // On an http:// LAN origin the Clipboard API is missing and a Paste button
  // could not read anything (only Ctrl+V works), so it is not shown there.
  const canReadClipboard = clipboardReadAvailable();
  const [preset, setPreset] = useState("best");
  const [destination, setDestination] =
    useState<DownloadDestination>("library");
  const [allPresets, setAllPresets] = useState<string[]>([...PRESET_ORDER]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<DownloadPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<{
    message: string;
    kind?: string;
  } | null>(null);

  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState("");
  const [channels, setChannels] = useState<ChannelStat[]>([]);

  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [importedPlaylist, setImportedPlaylist] = useState<{
    id: number;
    name: string;
  } | null>(null);

  const [playlistEntries, setPlaylistEntries] = useState<
    PlaylistPreviewEntry[]
  >([]);
  const [playlistName, setPlaylistName] = useState("");
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [playlistSizes, setPlaylistSizes] = useState<
    Record<string, Record<string, number>>
  >({});
  const [loadingPlaylist, setLoadingPlaylist] = useState(false);
  const [playlistMode, setPlaylistMode] = useState<
    "subscribe" | "import" | "videos"
  >("import");

  const [activeCollapsed, setActiveCollapsed] = useState(
    () => getItem(ACTIVE_COLLAPSE_KEY) === "true"
  );
  const [activeSectionVisible, setActiveSectionVisible] = useState(
    () => activeCount > 0
  );
  const [activeSectionEntered, setActiveSectionEntered] = useState(
    () => activeCount > 0
  );

  useEffect(() => {
    if (activeCount > 0) {
      setActiveSectionVisible(true);
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setActiveSectionEntered(true));
      });
      return () => cancelAnimationFrame(id);
    }
    setActiveSectionEntered(false);
    const t = window.setTimeout(() => setActiveSectionVisible(false), 320);
    return () => window.clearTimeout(t);
  }, [activeCount]);

  useEffect(() => {
    if (activeCount > 0 && activeCollapsed) {
      setActiveCollapsed(false);
    }
  }, [activeCount]); // eslint-disable-line react-hooks/exhaustive-deps -- expand when downloads become active; the user can collapse again without it re-opening

  const toggleActiveCollapsed = () => {
    setActiveCollapsed((v) => {
      const next = !v;
      setItem(ACTIVE_COLLAPSE_KEY, String(next));
      return next;
    });
  };

  useEffect(() => {
    api
      .listPresets()
      .then(setAllPresets)
      .catch(() => undefined);
    api
      .listChannels()
      .then(setChannels)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const urls = parseDownloadUrlList(url);
    if (urls.length > 1) {
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
      setPlaylistMode("import");
      return;
    }
    const trimmed = urls[0] ?? url.trim();
    if (!trimmed) {
      setPreview(null);
      setPreviewError(null);
      setPreset("best");
      setPlaylistMode("import");
      return;
    }
    setPreviewing(true);
    const id = setTimeout(() => {
      api
        .previewDownload(trimmed)
        .then((p) => {
          setPreview(p);
          setPreviewError(null);
          setTitle(p.title ?? "");
          // Leave channel empty so the picker stays on "Auto-detected".
          if (!p.is_playlist && p.available_presets.length > 0) {
            setPreset((current) =>
              current !== "best" ? current : p.available_presets[0]
            );
          }
        })
        .catch((err: unknown) => {
          setPreview(null);
          if (err instanceof ApiError) {
            setPreviewError({
              message: err.message,
              kind: err.errorKind,
            });
          } else if (err instanceof Error) {
            setPreviewError({ message: err.message });
          } else {
            setPreviewError({ message: "Could not read link" });
          }
        })
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

  const urlList = useMemo(() => parseDownloadUrlList(url), [url]);
  const isBulkList = urlList.length > 1;

  const metadataLoaded =
    !isBulkList &&
    preview != null &&
    !preview.is_playlist &&
    preview.available_presets.length > 0;

  const qualityOptions = useMemo(() => {
    if (!metadataLoaded) return allPresets;
    return mergePinnedPreset(preview!.available_presets, preset);
  }, [metadataLoaded, preview, preset, allPresets]);

  const isPlaylist = !isBulkList && (preview?.is_playlist ?? false);
  const toDevice = !isPlaylist && destination === "device";
  const presetSizes = preview?.preset_sizes;
  const selectedPresetSize = presetSizes?.[preset];

  useEffect(() => {
    if (isPlaylist && destination === "device") {
      setDestination("library");
    }
  }, [isPlaylist, destination]);

  const downloadButtonLabel = useMemo(() => {
    if (submitting) return "Starting...";
    if (isBulkList) {
      const n = urlList.length;
      return `Download ${n} video${n === 1 ? "" : "s"}`;
    }
    const approx = formatApproxSize(selectedPresetSize);
    if (toDevice) {
      return approx ? `Download to client (${approx})` : "Download to client";
    }
    return approx ? `Download (${approx})` : "Download";
  }, [submitting, selectedPresetSize, toDevice, isBulkList, urlList.length]);

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
    if (playlistMode === "subscribe") {
      const count = playlistEntries.length;
      const base =
        count === 0
          ? "Subscribe"
          : `Subscribe (${count} video${count === 1 ? "" : "s"})`;
      return base;
    }
    const count = selectedUrls.size;
    const approx = formatApproxSize(playlistTotalSize);
    if (playlistMode === "videos") {
      const base =
        count === 0
          ? "Download videos"
          : `Download ${count} video${count === 1 ? "" : "s"}`;
      return approx ? `${base} (${approx})` : base;
    }
    const base =
      count === 0
        ? "Import playlist"
        : `Import ${count} video${count === 1 ? "" : "s"}`;
    return approx ? `${base} (${approx})` : base;
  }, [
    submitting,
    playlistMode,
    playlistEntries.length,
    selectedUrls.size,
    playlistTotalSize,
  ]);

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

  const applyClipboardText = useCallback((text: string) => {
    const urls = parseDownloadUrlList(text);
    if (urls.length > 1) {
      setUrl(urls.join(", "));
      return true;
    }
    const next = urls[0] || clipboardTextToUrl(text);
    if (!next) return false;
    setUrl(next);
    return true;
  }, []);

  // Native paste always carries the clipboard (including http://LAN). Don't
  // steal it from other fields; do take it from the page or the Paste button.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!shouldCapturePagePaste(e.target, urlInputRef.current)) return;
      const next = parseDownloadUrlList(clipboardEventToText(e.clipboardData));
      if (next.length === 0) return;
      e.preventDefault();
      setPasteHint("");
      setUrl(next.length > 1 ? next.join(", ") : next[0]!);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

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
    // Oldest active first so the first download stays on top.
    active.sort((a, b) => {
      const ta = a.created_at ? Date.parse(a.created_at) : 0;
      const tb = b.created_at ? Date.parse(b.created_at) : 0;
      return ta - tb;
    });
    return { activeJobs: active, recentJobs: recent };
  }, [jobs, progress]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const urls = parseDownloadUrlList(url);
    if (urls.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      if (urls.length > 1) {
        const toSend: string[] = [];
        const localSkips: DownloadBulkSkip[] = [];
        for (const item of urls) {
          if (isYoutubeShortsUrl(item)) {
            localSkips.push({ url: item, reason: "shorts" });
            continue;
          }
          if (isYoutubePlaylistOnlyUrl(item)) {
            localSkips.push({ url: item, reason: "playlist" });
            continue;
          }
          toSend.push(item);
        }
        toastBulkSkips(localSkips, showToast);
        if (toSend.length === 0) return;
        const result = await submitBulkDownloads(toSend, preset, {
          destination: toDevice ? "device" : "library",
        });
        toastBulkSkips(result.skips, showToast);
      } else {
        const detectedTitle = (preview?.title ?? "").trim();
        const detectedChannel = (preview?.channel ?? "").trim();
        const t = title.trim();
        const c = channel.trim();
        await submitDownload(urls[0]!, preset, {
          title: t && t !== detectedTitle ? t : undefined,
          channel: toDevice || !c || c === detectedChannel ? undefined : c,
          destination: toDevice ? "device" : "library",
        });
      }
      setUrl("");
      setPreview(null);
      setPreviewError(null);
      setTitle("");
      setChannel("");
      setDestination("library");
    } catch (err) {
      if (err instanceof ApiError && err.code) {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Download failed");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const importAll = async () => {
    const selected = [...selectedUrls];
    if (!url.trim()) return;
    if (playlistMode !== "subscribe" && selected.length === 0) return;
    setSubmitting(true);
    setError(null);
    setImportMessage(null);
    setImportedPlaylist(null);
    try {
      if (playlistMode === "videos") {
        const result = await submitBulkDownloads(selected, preset);
        refreshJobs();
        const queued = result.jobs.length;
        const skipped = result.skipped;
        const parts = [
          queued
            ? `Queued ${queued} video${queued === 1 ? "" : "s"}`
            : "No new downloads",
        ];
        if (skipped) {
          parts.push(`${skipped} skipped`);
        }
        setImportMessage(`${parts.join(" — ")}.`);
        toastBulkSkips(result.skips, showToast);
        setUrl("");
        setPreview(null);
        setPreviewError(null);
        setPlaylistEntries([]);
        setSelectedUrls(new Set());
        setPlaylistName("");
        setPlaylistMode("import");
        return;
      }
      const created = await api.importPlaylist(url.trim(), preset, {
        name: playlistName.trim() || undefined,
        entries: playlistMode === "subscribe" ? undefined : selected,
        subscribe: playlistMode === "subscribe",
      });
      setImportedPlaylist({ id: created.id, name: created.name });
      setImportMessage(
        playlistMode === "subscribe"
          ? `Subscribed to "${created.name}" — new videos will download automatically.`
          : `Importing "${created.name}" — videos will appear in your library as they finish.`
      );
      setUrl("");
      setPreview(null);
      setPreviewError(null);
      setPlaylistEntries([]);
      setSelectedUrls(new Set());
      setPlaylistName("");
      setPlaylistMode("import");
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
        className="ui-panel space-y-4 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700"
      >
        <div>
          <label className="mb-1 flex items-center gap-1.5 text-sm font-medium text-gray-300">
            Video URL
            <span className="group relative inline-flex">
              <span className="flex h-4 w-4 cursor-help items-center justify-center rounded-full bg-ink-700 text-[10px] font-bold text-gray-300">
                ?
              </span>
              <span className="pointer-events-none absolute left-1/2 top-6 z-10 w-64 -translate-x-1/2 rounded-lg bg-ink-800 p-3 text-xs font-normal leading-relaxed text-gray-300 opacity-0 ring-1 ring-ink-600 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                Works with YouTube, Vimeo, Twitch, TikTok, Twitter/X,
                Dailymotion, SoundCloud, and{" "}
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
              ref={urlInputRef}
              value={url}
              onChange={(e) => {
                setPasteHint("");
                setUrl(e.target.value);
              }}
              placeholder="Video or playlist URL (YouTube, etc.)"
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-muted outline-hidden focus:border-accent"
            />
            {canReadClipboard && (
              <button
                type="button"
                onClick={async () => {
                  const before = urlInputRef.current?.value ?? "";
                  let filledFromField = false;
                  const text = await pasteTextFromButtonClick({
                    clipboardReadAvailable: canReadClipboard,
                    readClipboard: readClipboardText,
                    execPaste: () => {
                      const el = urlInputRef.current;
                      const ok = execPasteInto(el);
                      // execCommand can fill a controlled input without onChange.
                      if (el?.value && el.value !== before) {
                        filledFromField = applyClipboardText(el.value);
                      }
                      return ok;
                    },
                  });
                  if (applyClipboardText(text) || filledFromField) {
                    setPasteHint("");
                    return;
                  }
                  setPasteHint(
                    insecureClipboardHint(
                      typeof window !== "undefined" && window.isSecureContext
                    ) ||
                      "Couldn't read the clipboard. Paste with Ctrl+V, ⌘V, or a long-press."
                  );
                }}
                className="ui-panel ui-interactive shrink-0 rounded-lg border border-ink-700 bg-ink-800 px-4 py-2.5 text-sm text-gray-300 ring-1 ring-ink-700 hover:border-accent hover:text-accent"
              >
                Paste
              </button>
            )}
          </div>
          <p className="mt-1 text-xs text-muted">
            Accepts comma-separated links.
          </p>
          {pasteHint && (
            <p className="mt-1 text-xs text-amber-200/90">{pasteHint}</p>
          )}
          {previewing && !isBulkList && (
            <p className="mt-1 text-xs text-muted">Reading link...</p>
          )}
          {!previewing && previewError && (
            <div className="mt-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              <p className="font-medium">
                {downloadErrorLabel(previewError.kind)}
              </p>
              <p className="mt-0.5 text-xs text-red-300/90">
                {previewError.message}
              </p>
              {downloadErrorHint(previewError.kind) && (
                <p className="mt-1 text-xs text-red-400/80">
                  {downloadErrorHint(previewError.kind)}
                </p>
              )}
            </div>
          )}
        </div>

        <Collapse open={!isPlaylist && !isBulkList}>
          <div className={toDevice ? undefined : "space-y-4"}>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-300">
                {toDevice ? "File name" : "Title"}
              </label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Auto-detected"
                className="ui-interactive w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-muted outline-hidden focus:border-accent"
              />
            </div>
            <Collapse open={!toDevice}>
              <div>
                <span className="mb-1 block text-sm font-medium text-gray-300">
                  Channel
                </span>
                <ChannelPicker
                  value={channel}
                  onChange={setChannel}
                  channels={channels}
                  placeholder="Auto-detected"
                />
              </div>
            </Collapse>
          </div>
        </Collapse>

        <Collapse
          open={!!(preview && isPlaylist)}
          className={preview && isPlaylist ? undefined : "mb-0!"}
        >
          <div className="space-y-4 rounded-lg border border-accent/30 bg-accent/5 p-4">
            <PlaylistModePicker
              playlistMode={playlistMode}
              onChange={setPlaylistMode}
            />

            {playlistMode !== "videos" && (
              <div>
                <label
                  htmlFor="download-playlist-name"
                  className="mb-1 block text-sm font-medium text-gray-300"
                >
                  Playlist name
                </label>
                <input
                  id="download-playlist-name"
                  value={playlistName}
                  onChange={(e) => setPlaylistName(e.target.value)}
                  placeholder="Playlist name"
                  className="ui-interactive w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-muted outline-hidden focus:border-accent"
                />
              </div>
            )}

            {loadingPlaylist ? (
              <LoadingIndicator label="Loading playlist" className="py-4" />
            ) : playlistEntries.length > 0 ? (
              <>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-gray-300">
                    {playlistMode === "subscribe"
                      ? `${playlistEntries.length} video${
                          playlistEntries.length === 1 ? "" : "s"
                        } on this playlist`
                      : `${selectedUrls.size} of ${playlistEntries.length} selected`}
                  </p>
                  {playlistMode !== "subscribe" && (
                    <button
                      type="button"
                      onClick={toggleAllPlaylistEntries}
                      className="text-xs text-accent hover:underline"
                    >
                      {allPlaylistSelected ? "Deselect all" : "Select all"}
                    </button>
                  )}
                </div>
                <PlaylistEntryList
                  entries={playlistEntries}
                  playlistMode={playlistMode}
                  selectedUrls={selectedUrls}
                  onToggle={togglePlaylistEntry}
                />
              </>
            ) : (
              <p className="text-xs text-gray-400">
                {preview?.entry_count ?? 0} video
                {(preview?.entry_count ?? 0) === 1 ? "" : "s"} detected.
              </p>
            )}
          </div>
        </Collapse>

        <div>
          <span className="mb-1 block text-sm font-medium text-gray-300">
            Quality
          </span>
          <ThemedSelect
            aria-label="Quality"
            value={preset}
            options={qualityOptions.map((p) => ({
              value: p,
              label: presetOptionLabel(
                p,
                metadataLoaded ? presetSizes : undefined
              ),
            }))}
            onChange={setPreset}
            className="w-full"
            buttonClassName="w-full px-3 py-2.5"
          />
        </div>

        <Collapse open={!isPlaylist}>
          <div>
            <span
              id="download-destination-label"
              className="mb-1 block text-sm font-medium text-gray-300"
            >
              Destination
            </span>
            <div
              role="group"
              aria-labelledby="download-destination-label"
              className="grid grid-cols-2 gap-2"
            >
              <button
                type="button"
                onClick={() => setDestination("library")}
                className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  destination === "library"
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-ink-700 bg-ink-950 text-gray-300 hover:border-ink-500"
                }`}
              >
                Save to library
              </button>
              <button
                type="button"
                onClick={() => setDestination("device")}
                className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  destination === "device"
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-ink-700 bg-ink-950 text-gray-300 hover:border-ink-500"
                }`}
              >
                Direct download to client
              </button>
            </div>
            {toDevice && (
              <p className="mt-2 text-xs text-muted">
                The server fetches the file and sends it straight to this
                device; it is not added to the library.
              </p>
            )}
          </div>
        </Collapse>

        {isPlaylist ? (
          <button
            type="button"
            onClick={importAll}
            disabled={
              submitting ||
              !url.trim() ||
              (playlistMode !== "subscribe" && selectedUrls.size === 0)
            }
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
        {importMessage && (
          <p className="text-sm text-accent">
            {importMessage}
            {importedPlaylist && (
              <>
                {" "}
                <Link
                  to={`/playlists?open=${importedPlaylist.id}`}
                  className="underline hover:text-accent-soft"
                >
                  Open playlist
                </Link>
              </>
            )}
          </p>
        )}
      </form>

      <SendLinksHelp />

      {activeSectionVisible && (
        <section
          className={`ui-panel mt-6 rounded-xl bg-accent/5 p-4 ring-1 ring-accent/40 transition-[opacity,translate] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            activeSectionEntered
              ? "translate-y-0 opacity-100"
              : "pointer-events-none translate-y-2 opacity-0"
          }`}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={toggleActiveCollapsed}
              className="ui-interactive flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left"
            >
              <span className="text-gray-400">
                {activeCollapsed ? "▶" : "▼"}
              </span>
              <span className="text-sm font-semibold text-gray-100">
                Active downloads
              </span>
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-bold text-ink-950">
                {activeCount}
              </span>
            </button>
            <div className="flex shrink-0 gap-2">
              {!isAdmin ? (
                queuePaused && (
                  <span className="rounded-lg bg-ink-800 px-3 py-1.5 text-xs font-medium text-gray-300">
                    Paused by an administrator
                  </span>
                )
              ) : queuePaused ? (
                <button
                  type="button"
                  onClick={() => resumeQueue()}
                  className="ui-interactive rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-ink-950 hover:bg-accent-soft"
                >
                  Resume all
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => pauseQueue()}
                  className="ui-interactive rounded-lg bg-ink-800 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-ink-700"
                >
                  Pause all
                </button>
              )}
            </div>
          </div>
          {queueHeldReason && (
            <p
              role="status"
              className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300"
            >
              {queueHeldReason}. Waiting downloads start by themselves when
              there is room.
              {isAdmin && (
                <>
                  {" "}
                  <Link
                    to="/settings?tab=system"
                    className="underline hover:text-amber-200"
                  >
                    Storage settings
                  </Link>
                </>
              )}
            </p>
          )}
          <Collapse open={!activeCollapsed}>
            <div className="space-y-4">
              {activeJobs.map((job) => (
                <div
                  key={job.id}
                  className="transition-[opacity,translate] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] starting:translate-y-2 starting:opacity-0 motion-reduce:starting:translate-y-0"
                >
                  <DownloadJobCard
                    job={job}
                    live={progress[job.id]}
                    channels={channels}
                    active
                  />
                </div>
              ))}
            </div>
          </Collapse>
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
            {recentJobs.some(
              (j) =>
                j.status === "completed" ||
                j.status === "error" ||
                j.status === "cancelled"
            ) && (
              <button
                type="button"
                onClick={dismissFinishedJobs}
                className="text-xs text-muted hover:text-accent"
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
