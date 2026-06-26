import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useDownloads } from "../context/DownloadContext";
import type { ChannelStat, DownloadJob, ProgressEvent } from "../types";
import ChannelPicker from "./ChannelPicker";

interface Props {
  job: DownloadJob;
  live?: ProgressEvent;
  channels: ChannelStat[];
}

const labelClass = "mb-1 block text-xs font-medium text-gray-400";

export default function DownloadJobCard({ job, live, channels }: Props) {
  const { updateJobOverrides, submitDownload } = useDownloads();
  const status = live?.status ?? job.status;
  const percent = Math.round(live?.progress ?? job.progress);
  const completed = status === "completed";
  const failed = status === "error";
  const videoId = live?.video_id ?? job.video_id;

  const [title, setTitle] = useState(
    job.title_override ?? live?.title ?? job.title ?? ""
  );
  const [channel, setChannel] = useState(job.channel_override ?? "");
  const [saved, setSaved] = useState(false);

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
        });
      } else if (!completed && !failed) {
        await updateJobOverrides(job.id, { title, channel });
      }
      flashSaved();
    } catch {
      // leave fields as-is on failure
    }
  };

  const statusLabel = failed
    ? "Failed"
    : completed
      ? "Complete"
      : status === "processing"
        ? "Processing…"
        : status === "queued"
          ? "Queued"
          : `${percent}%`;

  return (
    <div className="rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700">
      <div className="mb-3 flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 font-medium text-gray-200">
          {completed && <span className="text-accent">✓</span>}
          <span className="truncate">{title || "Working…"}</span>
        </span>
        <span className={failed ? "text-red-400" : "text-gray-400"}>
          {statusLabel}
        </span>
      </div>

      {!completed && !failed && (
        <div className="mb-4 h-2.5 w-full overflow-hidden rounded-full bg-ink-700">
          <div
            className="h-full rounded-full bg-accent transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {failed ? (
        <div className="space-y-3">
          {live?.error && <p className="text-sm text-red-400">{live.error}</p>}
          <button
            onClick={() =>
              submitDownload(job.url, job.quality_preset, { title, channel })
            }
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className={labelClass}>Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={save}
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

      <div className="mt-3 flex items-center gap-3">
        {completed && videoId && (
          <Link
            to={`/watch/${videoId}`}
            className="inline-block rounded-lg bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
          >
            Watch now →
          </Link>
        )}
        {(completed || (!failed && status !== "queued")) && (
          <button
            onClick={save}
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
          >
            Save changes
          </button>
        )}
        {saved && <span className="text-xs text-accent">Saved</span>}
      </div>
    </div>
  );
}
