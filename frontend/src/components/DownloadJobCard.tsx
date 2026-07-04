import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useDownloads, jobStatus } from "../context/DownloadContext";
import type { ChannelStat, DownloadJob, ProgressEvent } from "../types";
import { formatSize } from "../utils";
import ChannelPicker from "./ChannelPicker";

interface Props {
  job: DownloadJob;
  live?: ProgressEvent;
  channels: ChannelStat[];
  active?: boolean;
}

const labelClass = "mb-1 block text-xs font-medium text-gray-400";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export default function DownloadJobCard({
  job,
  live,
  channels,
  active = false,
}: Props) {
  const { updateJobOverrides, submitDownload, cancelJob, dismissJob } =
    useDownloads();
  const status = jobStatus(job, live);
  const maxPercentRef = useRef(0);
  const maxBytesRef = useRef(0);
  if (status === "downloading" || status === "processing") {
    const raw = live?.progress ?? job.progress;
    maxPercentRef.current = Math.max(maxPercentRef.current, raw);
    if (live?.downloaded_bytes) {
      maxBytesRef.current = Math.max(
        maxBytesRef.current,
        live.downloaded_bytes
      );
    }
  } else {
    maxPercentRef.current = 0;
    maxBytesRef.current = 0;
  }
  const percent = Math.round(
    status === "downloading" || status === "processing"
      ? maxPercentRef.current
      : (live?.progress ?? job.progress)
  );
  const completed = status === "completed";
  const failed = status === "error";
  const cancelled = status === "cancelled";
  const videoId = live?.video_id ?? job.video_id;

  const resolveTitle = () => job.title_override ?? live?.title ?? job.title ?? "";
  const resolveChannel = () => job.channel_override ?? live?.channel ?? job.channel ?? "";

  const [title, setTitle] = useState(resolveTitle);
  const [channel, setChannel] = useState(resolveChannel);
  const [note, setNote] = useState(job.notes_pending ?? "");
  const [saved, setSaved] = useState(false);
  const [showNote, setShowNote] = useState(Boolean(job.notes_pending));

  const savedTitle = useRef(resolveTitle());
  const savedChannel = useRef(resolveChannel());

  useEffect(() => {
    const t = resolveTitle();
    const c = resolveChannel();
    const n = job.notes_pending ?? "";
    setTitle(t);
    setChannel(c);
    setNote(n);
    savedTitle.current = t;
    savedChannel.current = c;
  }, [job, live?.title, live?.channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const isDirty = title !== savedTitle.current || channel !== savedChannel.current;

  const flashSaved = () => {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  };

  const save = async () => {
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

  const saveNote = async () => {
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

  const onDismiss = async () => {
    if (completed || failed || cancelled) {
      if (!confirm("Remove this card from the list? The video stays in your library."))
        return;
      await dismissJob(job.id);
      return;
    }
    if (!confirm("Cancel this download?")) return;
    await cancelJob(job.id);
  };

  const statusLabel = failed
    ? "Failed"
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

  const thumbSrc = completed && videoId
    ? `/api/thumbnails/${videoId}`
    : job.thumbnail_url;

  const cardRing = active
    ? "ring-accent/50 border-l-4 border-l-accent"
    : "ring-ink-700";

  const errorMsg =
    failed && !completed ? stripAnsi(live?.error ?? job.error ?? "") : "";

  const sizeLabel = (() => {
    if (completed) {
      const bytes = live?.file_size ?? job.file_size;
      return bytes ? formatSize(bytes) : "";
    }
    if (status === "downloading" || status === "processing") {
      const total = live?.total_bytes;
      const downloaded = Math.max(
        maxBytesRef.current,
        live?.downloaded_bytes ?? 0
      );
      if (total) {
        return `${formatSize(downloaded || null)} / ${formatSize(total)}`;
      }
      if (downloaded) return formatSize(downloaded);
    }
    return "";
  })();

  return (
    <div className={`rounded-xl bg-ink-900 p-5 ring-1 ${cardRing}`}>
      <div className="flex gap-4">
        <div className="hidden h-20 w-36 shrink-0 overflow-hidden rounded-lg bg-ink-800 sm:block">
          {thumbSrc ? (
            <img
              src={thumbSrc}
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
          <div className="mb-3 flex items-start justify-between gap-3 overflow-hidden text-sm">
            <span className="flex min-w-0 flex-1 items-center gap-2 font-medium text-gray-200">
              {completed && <span className="shrink-0 text-accent">✓</span>}
              {failed && <span className="shrink-0 text-red-400">✗</span>}
              <span className="min-w-0 truncate">{title || "Working…"}</span>
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
                className="flex h-7 w-7 items-center justify-center rounded-md border border-ink-600 bg-ink-800 text-base leading-none text-gray-300 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-400"
                title={
                  completed || failed || cancelled
                    ? "Remove from list"
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

          {!completed && !failed && !cancelled && (
            <div className="mb-4 h-2.5 w-full overflow-hidden rounded-full bg-ink-700">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {failed && errorMsg && (
            <p className="mb-3 text-sm text-red-400">{errorMsg}</p>
          )}

          {!cancelled && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className={labelClass}>Title</label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                />
              </div>
              <div>
                <label className={labelClass}>Channel</label>
                <ChannelPicker
                  value={channel}
                  onChange={setChannel}
                  channels={channels}
                  placeholder="Channel"
                />
              </div>
            </div>
          )}

          {(showNote || note) && !cancelled && (
            <div className="mt-3">
              <label className={labelClass}>Note</label>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder="Personal note about this video..."
                className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              />
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {completed && videoId && (
              <Link
                to={`/watch/${videoId}`}
                className="inline-block rounded-lg bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
              >
                Watch now →
              </Link>
            )}
            {failed && (
              <button
                onClick={() =>
                  submitDownload(job.url, job.quality_preset, { title, channel })
                }
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Retry
              </button>
            )}
            {!failed && !cancelled && isDirty && (
              <button
                onClick={save}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Save changes
              </button>
            )}
            {!failed && !cancelled && (
              <button
                onClick={() => setShowNote((v) => !v)}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                {showNote ? "Hide note" : "Add note"}
              </button>
            )}
            {showNote && !cancelled && (
              <button
                onClick={saveNote}
                className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
              >
                Save note
              </button>
            )}
            {saved && <span className="text-xs text-accent">Saved</span>}
            {(sizeLabel || completed) && (
              <span className="ml-auto flex items-center gap-2 text-xs text-gray-500">
                {sizeLabel && <span>{sizeLabel}</span>}
                {completed && <span className="text-gray-400">Done</span>}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
