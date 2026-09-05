import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  deviceDownloadFileUrl,
  listThumbnailUrl,
  triggerBrowserDownload,
} from "../api";
import { useDownloads, jobStatus } from "../context/DownloadContext";
import { useToast } from "../context/ToastContext";
import {
  downloadErrorHint,
  downloadErrorLabel,
} from "../downloadErrors";
import type { ChannelStat, DownloadJob, ProgressEvent } from "../types";
import {
  downloadProgressPercent,
  formatSize,
  youtubeListThumbnailUrl,
} from "../utils";
import { PRESET_LABELS, PRESET_ORDER, finishedQualityLabel, jobQualityOptions, resolveQualityPreset } from "../presets";
import AddToPlaylist from "./AddToPlaylist";
import ChannelPicker from "./ChannelPicker";
import {
  applyActionRowCollapse,
  canChangeJobQuality,
  canEditDownloadJobNotes,
  canManageCompletedLibraryVideo,
  canRedownloadRemovedJob,
  isLibraryVideoGone,
} from "./downloadJobCardState";

interface Props {
  job: DownloadJob;
  live?: ProgressEvent;
  channels: ChannelStat[];
  active?: boolean;
}

const labelClass = "mb-1 block text-xs font-medium text-gray-400";
const SKIP_DISMISS_CONFIRM_KEY = "horde.downloads.skip-dismiss-confirm";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function skipDismissConfirm(): boolean {
  try {
    return localStorage.getItem(SKIP_DISMISS_CONFIRM_KEY) === "1";
  } catch {
    return false;
  }
}

export default function DownloadJobCard({
  job,
  live,
  channels,
  active = false,
}: Props) {
  const {
    updateJobOverrides,
    retryJob,
    cancelJob,
    dismissJob,
    submitDownload,
    changeJobQuality,
    refreshJobs,
  } = useDownloads();
  const { showToast } = useToast();
  const status = jobStatus(job, live);
  const maxBytesRef = useRef(0);
  if (status === "downloading" || status === "processing") {
    if (live?.downloaded_bytes) {
      maxBytesRef.current = Math.max(
        maxBytesRef.current,
        live.downloaded_bytes
      );
    }
  } else {
    maxBytesRef.current = 0;
  }
  const downloaded = Math.max(
    maxBytesRef.current,
    live?.downloaded_bytes ?? 0
  );
  const liveTotal =
    status === "downloading" || status === "processing"
      ? live?.total_bytes
      : undefined;
  const percent = downloadProgressPercent(
    live?.progress ?? job.progress,
    status === "downloading" || status === "processing" ? downloaded : undefined,
    liveTotal
  );
  const completed = status === "completed";
  const failed = status === "error";
  const cancelled = status === "cancelled";
  const canChangeQuality = canChangeJobQuality(
    status,
    failed,
    cancelled,
    completed
  );
  const videoId = live?.video_id ?? job.video_id;
  const isDeviceJob =
    (live?.destination ?? job.destination) === "device";
  const videoGone = isLibraryVideoGone(
    isDeviceJob,
    job.video_missing,
    job.superseded
  );
  const canEditNotes = canEditDownloadJobNotes(
    isDeviceJob,
    failed,
    cancelled,
    videoGone,
    completed
  );
  const inLibrary = canManageCompletedLibraryVideo(
    completed,
    isDeviceJob,
    videoGone,
    videoId
  );
  const canRedownload = canRedownloadRemovedJob(
    completed,
    isDeviceJob,
    failed,
    job.video_missing,
    job.superseded
  );
  const isReplacing =
    active && Boolean(job.replace_video_id) && !completed && !failed && !cancelled;

  const resolveTitle = () => job.title_override ?? live?.title ?? job.title ?? "";
  const resolveChannel = () => job.channel_override ?? live?.channel ?? job.channel ?? "";

  const [title, setTitle] = useState(resolveTitle);
  const [channel, setChannel] = useState(resolveChannel);
  const [note, setNote] = useState(job.notes_pending ?? "");
  const [saved, setSaved] = useState(false);
  const [showNote, setShowNote] = useState(Boolean(job.notes_pending));
  const [dismissConfirm, setDismissConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [redownloading, setRedownloading] = useState(false);
  const [changingQuality, setChangingQuality] = useState(false);
  const [sourcePresets, setSourcePresets] = useState<string[]>(
    () => job.available_presets ?? []
  );
  const [editingTitle, setEditingTitle] = useState(false);
  const retryingRef = useRef(false);
  const redownloadingRef = useRef(false);
  const editingTitleRef = useRef(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const actionRowRef = useRef<HTMLDivElement | null>(null);
  const collapseRoRef = useRef<ResizeObserver | null>(null);
  const previewFetchedFor = useRef<number | null>(null);
  editingTitleRef.current = editingTitle;

  const savedTitle = useRef(resolveTitle());
  const savedChannel = useRef(resolveChannel());

  useEffect(() => {
    const t = resolveTitle();
    const c = resolveChannel();
    const n = job.notes_pending ?? "";
    if (!editingTitleRef.current) {
      setTitle(t);
      savedTitle.current = t;
    }
    setChannel(c);
    setNote(n);
    savedChannel.current = c;
  }, [job, live?.title, live?.channel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editingTitle) return;
    const el = titleInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editingTitle]);

  const storedPresets = job.available_presets;
  useEffect(() => {
    if (storedPresets && storedPresets.length > 0) {
      setSourcePresets(storedPresets);
      return;
    }
    if (!canChangeQuality || !job.url) return;
    if (previewFetchedFor.current === job.id) return;
    let cancelledFetch = false;
    api
      .previewDownload(job.url)
      .then((p) => {
        if (cancelledFetch || p.is_playlist) return;
        previewFetchedFor.current = job.id;
        setSourcePresets(p.available_presets);
      })
      .catch(() => undefined);
    return () => {
      cancelledFetch = true;
    };
  }, [job.id, job.url, storedPresets, canChangeQuality]);

  const qualityOptions = jobQualityOptions(
    sourcePresets,
    job.quality_preset,
    [...PRESET_ORDER]
  );
  const displayPreset = resolveQualityPreset(
    job.quality_preset || "best",
    sourcePresets
  );
  const finishedRes = completed
    ? finishedQualityLabel(
        job.quality_preset,
        job.height_px,
        sourcePresets
      )
    : "";
  const inFlightRes =
    !completed && job.quality_preset
      ? PRESET_LABELS[displayPreset] ?? displayPreset
      : "";
  const resLabel = completed ? finishedRes : inFlightRes;

  const setActionRow = useCallback((node: HTMLDivElement | null) => {
    collapseRoRef.current?.disconnect();
    collapseRoRef.current = null;
    actionRowRef.current = node;
    if (!node) return;
    applyActionRowCollapse(node);
    const ro = new ResizeObserver(() => applyActionRowCollapse(node));
    ro.observe(node);
    collapseRoRef.current = ro;
  }, []);

  useLayoutEffect(() => {
    const row = actionRowRef.current;
    if (row) applyActionRowCollapse(row);
  });

  const isDirty = title !== savedTitle.current || channel !== savedChannel.current;

  const flashSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const canEditTitle = !cancelled && !videoGone;

  const startTitleEdit = () => {
    if (!canEditTitle) return;
    setEditingTitle(true);
  };

  const save = async () => {
    if (videoGone) return;
    try {
      if (completed && videoId) {
        await api.updateVideo(videoId, {
          title: title.trim() || undefined,
          channel: channel.trim() || undefined,
          notes: note.trim() || undefined,
        });
      } else if (!completed && !failed && !cancelled) {
        await updateJobOverrides(job.id, { title, channel, notes: note });
      }
      savedTitle.current = title;
      savedChannel.current = channel;
      flashSaved();
    } catch {
      // leave fields as-is on failure
    }
  };

  const finishTitleEdit = async (commit: boolean) => {
    editingTitleRef.current = false;
    if (!commit) {
      setTitle(savedTitle.current);
      setEditingTitle(false);
      return;
    }
    setEditingTitle(false);
    if (title !== savedTitle.current) {
      await save();
    }
  };

  const saveNote = async () => {
    if (!canEditNotes) return;
    try {
      if (completed && videoId) {
        await api.updateVideo(videoId, { notes: note.trim() || null });
      } else {
        await updateJobOverrides(job.id, { notes: note });
      }
      flashSaved();
    } catch {
      // ignore
    }
  };

  const confirmDismiss = async () => {
    if (dontAskAgain) {
      try {
        localStorage.setItem(SKIP_DISMISS_CONFIRM_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setDismissConfirm(false);
    await dismissJob(job.id);
  };

  const onDismiss = async () => {
    if (completed || failed || cancelled) {
      if (skipDismissConfirm()) {
        await dismissJob(job.id);
        return;
      }
      setDontAskAgain(false);
      setDismissConfirm(true);
      return;
    }
    if (!confirm("Cancel this download?")) return;
    await cancelJob(job.id);
  };

  const confirmDeleteFromLibrary = async () => {
    if (!videoId || deleting) return;
    setDeleting(true);
    try {
      await api.deleteVideo(videoId, true);
      setDeleteConfirm(false);
      refreshJobs();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not delete video"
      );
    } finally {
      setDeleting(false);
    }
  };

  const onRetry = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetrying(true);
    try {
      await retryJob(job.id, {
        title,
        channel,
        destination: isDeviceJob ? "device" : "library",
      });
    } catch {
      retryingRef.current = false;
      setRetrying(false);
    }
  };

  const onRedownload = async () => {
    if (redownloadingRef.current || !job.url) return;
    redownloadingRef.current = true;
    setRedownloading(true);
    try {
      await submitDownload(job.url, job.quality_preset || "best", {
        title: title.trim() || undefined,
        channel: channel.trim() || undefined,
        notes: note.trim() || undefined,
        destination: "library",
      });
    } finally {
      redownloadingRef.current = false;
      setRedownloading(false);
    }
  };

  const onChangeQuality = async (preset: string) => {
    if (!canChangeQuality || changingQuality) return;
    if (preset === displayPreset) return;
    setChangingQuality(true);
    try {
      await changeJobQuality(job.id, preset);
    } catch {
      // job refresh in context restores the previous preset
    } finally {
      setChangingQuality(false);
    }
  };

  const statusLabel = failed
    ? downloadErrorLabel(live?.error_kind ?? job.error_kind)
    : cancelled
      ? "Cancelled"
      : completed
        ? "Done"
        : status === "processing"
          ? "Processing…"
          : status === "queued"
            ? job.paused || live?.status === "queued"
              ? "Paused"
              : "Queued"
            : `${percent}%`;

  const remoteList = youtubeListThumbnailUrl(job.url, job.thumbnail_url);
  const thumbFallbacks = [
    completed && videoId ? listThumbnailUrl(videoId) : null,
    remoteList,
    completed && videoId ? `/api/thumbnails/${videoId}` : null,
    job.thumbnail_url,
  ].filter((u, i, arr): u is string => !!u && arr.indexOf(u) === i);
  const thumbSrc = thumbFallbacks[0] ?? null;

  const errorKind = failed ? live?.error_kind ?? job.error_kind ?? null : null;
  const errorMsg =
    failed && !completed ? stripAnsi(live?.error ?? job.error ?? "") : "";
  const errorHint = failed ? downloadErrorHint(errorKind) : null;

  const sizeLabel = (() => {
    if (completed) {
      const bytes = live?.file_size ?? job.file_size;
      return bytes ? formatSize(bytes) : "";
    }
    if (status === "downloading" || status === "processing") {
      const total = liveTotal;
      if (total) {
        return `${formatSize(downloaded || null)} / ${formatSize(total)}`;
      }
      if (downloaded) return formatSize(downloaded);
    }
    return "";
  })();

  return (
    <>
    <div
      className={`ui-panel relative rounded-xl border border-ink-700 bg-ink-900 p-5 ring-1 ring-ink-700 ${
        active ? "overflow-hidden border-l-4 border-l-accent pl-[calc(1.25rem-2px)]" : ""
      }${videoGone ? " opacity-60" : ""}${playlistOpen ? " z-30" : ""}`}
    >
      <div className="mb-3 flex items-start justify-between gap-3 text-sm">
        <span className="flex min-w-0 flex-1 items-center gap-2 font-medium text-gray-200">
          {completed && !videoGone && (
            <span className="shrink-0 text-accent">✓</span>
          )}
          {failed && <span className="shrink-0 text-red-400">✗</span>}
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (!editingTitleRef.current) return;
                void finishTitleEdit(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void finishTitleEdit(true);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  void finishTitleEdit(false);
                }
              }}
              placeholder="Title"
              className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-950 px-2 py-1 text-sm font-medium text-gray-100 outline-none focus:border-accent"
            />
          ) : (
            <>
              <span
                className={`min-w-0 truncate${
                  videoGone ? " text-gray-500 line-through" : ""
                }${canEditTitle ? " cursor-text" : ""}`}
                onClick={startTitleEdit}
                title={title || undefined}
              >
                {title || "Working…"}
              </span>
              {canEditTitle && (
                <button
                  type="button"
                  onClick={startTitleEdit}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 hover:text-accent"
                  title="Edit title"
                  aria-label="Edit title"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-3.5 w-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )}
            </>
          )}
          {job.superseded && (
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Replaced
            </span>
          )}
          {job.video_missing && !job.superseded && (
            <span className="shrink-0 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Removed
            </span>
          )}
          {isReplacing && (
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
              Replacing
            </span>
          )}
          {isDeviceJob && (
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-accent">
              This device
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          {!completed && (
            <span
              className={`${failed ? "text-red-400" : "text-gray-400"}`}
            >
              {statusLabel}
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className={
              completed || failed || cancelled
                ? "flex h-7 w-7 items-center justify-center rounded-md border border-ink-600 bg-ink-800 text-base leading-none text-gray-400 hover:border-ink-500 hover:bg-ink-700 hover:text-gray-200"
                : "flex h-7 w-7 items-center justify-center rounded-md border border-ink-600 bg-ink-800 text-base leading-none text-gray-300 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400"
            }
            title={
              completed || failed || cancelled
                ? "Remove from list (video stays in library)"
                : "Cancel download"
            }
            aria-label={
              completed || failed || cancelled
                ? "Remove from list"
                : "Cancel download"
            }
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex items-start gap-4">
        <div
          className={`hidden h-[6.75rem] w-52 shrink-0 overflow-hidden rounded-lg bg-ink-800 sm:block${
            videoGone ? " grayscale" : ""
          }`}
        >
          {thumbSrc ? (
            <img
              key={`${job.id}-${thumbSrc}`}
              src={thumbSrc}
              alt=""
              decoding="async"
              className="h-full w-full object-cover"
              onError={(e) => {
                const el = e.currentTarget;
                const nextIdx = Number(el.dataset.fallbackIdx || "0") + 1;
                const next = thumbFallbacks[nextIdx];
                if (!next) return;
                el.dataset.fallbackIdx = String(nextIdx);
                el.src = next;
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-gray-600">
              No preview
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          {!completed && !failed && !cancelled && (
            <div className="mb-4 h-2.5 w-full overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {failed && (errorMsg || errorHint) && (
            <div className="mb-3 space-y-1 text-sm text-red-400">
              {errorMsg && <p>{errorMsg}</p>}
              {errorHint && errorHint !== errorMsg && (
                <p className="text-xs text-red-400/80">{errorHint}</p>
              )}
            </div>
          )}

          {!cancelled && (
            <div className="w-full sm:max-w-md">
              <label className={labelClass}>Channel</label>
              <ChannelPicker
                value={channel}
                onChange={setChannel}
                channels={channels}
                placeholder="Channel"
              />
            </div>
          )}

          {canEditNotes && (showNote || note) && (
            <div className="mt-3">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <label className={labelClass + " mb-0"}>Note</label>
              </div>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Personal note about this video..."
                className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              />
            </div>
          )}

          <div
            ref={setActionRow}
            className="mt-3 flex min-w-0 flex-nowrap items-center gap-1.5 overflow-x-hidden sm:gap-2"
          >
            {completed && isDeviceJob && (
              <button
                type="button"
                onClick={() =>
                  triggerBrowserDownload(deviceDownloadFileUrl(job.id))
                }
                className="inline-block shrink-0 whitespace-nowrap rounded-lg bg-accent/15 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm font-medium text-accent hover:bg-accent/25"
              >
                Save again
              </button>
            )}
            {inLibrary && videoId != null && (
              <>
                <Link
                  to={`/watch/${videoId}`}
                  className="inline-block shrink-0 whitespace-nowrap rounded-lg bg-accent/15 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm font-medium text-accent hover:bg-accent/25"
                >
                  Watch →
                </Link>
                <button
                  type="button"
                  onClick={() => setDeleteConfirm(true)}
                  disabled={deleting}
                  title="Delete this video from your library"
                  className="shrink-0 whitespace-nowrap rounded-lg bg-red-500/15 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm font-medium text-red-400 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Delete
                </button>
                <div data-collapse="playlist" className="shrink-0">
                  <AddToPlaylist
                    videoId={videoId}
                    buttonClassName="shrink-0 whitespace-nowrap rounded-lg bg-ink-800 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm text-gray-200 hover:bg-ink-700"
                    onOpenChange={setPlaylistOpen}
                  />
                </div>
              </>
            )}
            {canRedownload && (
              <button
                type="button"
                onClick={onRedownload}
                disabled={redownloading || !job.url}
                className="shrink-0 whitespace-nowrap rounded-lg bg-accent/15 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm font-medium text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {redownloading ? "Starting…" : "Redownload"}
              </button>
            )}
            {completed && !isDeviceJob && videoGone && (
              <span className="shrink-0 whitespace-nowrap text-xs text-gray-500">
                {job.video_missing
                  ? "Video no longer in library"
                  : "Superseded by a newer download"}
              </span>
            )}
            {failed && (
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                className="shrink-0 whitespace-nowrap rounded-lg bg-ink-800 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm text-gray-200 hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {retrying ? "Retrying…" : "Retry"}
              </button>
            )}
            {!failed && !cancelled && !videoGone && isDirty && (
              <button
                onClick={save}
                className="shrink-0 whitespace-nowrap rounded-lg bg-ink-800 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm text-gray-200 hover:bg-ink-700"
              >
                Save changes
              </button>
            )}
            {canEditNotes && (
              <button
                onClick={() => setShowNote((v) => !v)}
                className="shrink-0 whitespace-nowrap rounded-lg bg-ink-800 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm text-gray-200 hover:bg-ink-700"
              >
                {showNote ? "Hide note" : "Add note"}
              </button>
            )}
            {canEditNotes && showNote && (
              <button
                onClick={saveNote}
                className="shrink-0 whitespace-nowrap rounded-lg bg-ink-800 px-2 py-1 text-xs sm:px-2.5 sm:py-1.5 sm:text-sm text-gray-200 hover:bg-ink-700"
              >
                Save note
              </button>
            )}
            {saved && <span className="shrink-0 text-xs text-accent">Saved</span>}
            <span className="min-w-0 flex-1" data-collapse-ignore aria-hidden />
            {sizeLabel ? (
              <span
                data-collapse="size"
                className="shrink-0 whitespace-nowrap text-xs text-gray-500"
              >
                {sizeLabel}
              </span>
            ) : null}
            {canChangeQuality ? (
              <select
                data-collapse="res"
                value={displayPreset}
                disabled={changingQuality}
                onChange={(e) => void onChangeQuality(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                aria-label="Download resolution"
                className="shrink-0 cursor-pointer rounded bg-ink-800 px-1.5 py-0.5 text-xs text-gray-400 outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
              >
                {qualityOptions.map((p) => (
                  <option key={p} value={p}>
                    {PRESET_LABELS[p] ?? p}
                  </option>
                ))}
              </select>
            ) : resLabel ? (
              <span
                data-collapse="res"
                className="shrink-0 whitespace-nowrap rounded bg-ink-800 px-1.5 py-0.5 text-xs text-gray-400"
              >
                {resLabel}
              </span>
            ) : null}
            {completed && (!videoGone || isDeviceJob) && (
              <span
                data-collapse="done"
                className="shrink-0 whitespace-nowrap text-xs text-gray-400"
              >
                Done
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
    {dismissConfirm && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
        <div className="ui-panel w-full max-w-sm rounded-xl bg-ink-900 p-5 ring-1 ring-ink-600 shadow-xl">
          <p className="text-sm text-gray-200">
            {isDeviceJob
              ? "Remove this card? The temporary file on the server will be deleted."
              : "Remove this card from the list? The video stays in your library. To delete the file, use Delete."}
          </p>
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              className="rounded border-ink-600"
            />
            Don&apos;t ask again
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDismissConfirm(false)}
              className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-300 hover:bg-ink-700"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDismiss}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft"
            >
              Remove
            </button>
          </div>
        </div>
      </div>
    )}
    {deleteConfirm && (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4">
        <div className="ui-panel w-full max-w-sm rounded-xl bg-ink-900 p-5 shadow-xl ring-1 ring-ink-600">
          <p className="text-sm text-gray-200">
            Delete this video from your library? The file will be removed. This
            card stays so you can redownload. Use × if you only want to hide the
            card.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDeleteConfirm(false)}
              disabled={deleting}
              className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-300 hover:bg-ink-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDeleteFromLibrary()}
              disabled={deleting}
              className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Delete from library"}
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
