import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useDownloadProgress } from "../hooks/useDownloadProgress";
import type { ChannelStat, DownloadPreview } from "../types";

const PRESET_LABELS: Record<string, string> = {
  best: "Best available",
  "1440p": "1440p (2K)",
  "1080p": "1080p",
  "720p": "720p",
  "480p": "480p",
  audio: "Audio only",
};

export default function Download() {
  const [url, setUrl] = useState("");
  const [preset, setPreset] = useState("best");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [preview, setPreview] = useState<DownloadPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const [overrideTitle, setOverrideTitle] = useState(false);
  const [overrideChannel, setOverrideChannel] = useState(false);
  const [titleValue, setTitleValue] = useState("");
  const [channelValue, setChannelValue] = useState("");
  const [channels, setChannels] = useState<ChannelStat[]>([]);

  const [importMessage, setImportMessage] = useState<string | null>(null);

  const progress = useDownloadProgress(jobId);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
    api.listChannels().then(setChannels).catch(() => undefined);
  }, []);

  // Inspect the link (debounced) so we can show and optionally override the
  // detected title/channel, and detect playlists.
  useEffect(() => {
    const trimmed = url.trim();
    if (!trimmed) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const id = setTimeout(() => {
      api
        .previewDownload(trimmed)
        .then((p) => {
          setPreview(p);
          setTitleValue(p.title ?? "");
          setChannelValue(p.channel ?? "");
        })
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 600);
    return () => {
      clearTimeout(id);
      setPreviewing(false);
    };
  }, [url]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createDownload(url.trim(), preset, {
        title_override:
          overrideTitle && titleValue.trim() ? titleValue.trim() : undefined,
        channel_override:
          overrideChannel && channelValue.trim()
            ? channelValue.trim()
            : undefined,
      });
      setJobId(job.id);
      setUrl("");
      setPreview(null);
      setOverrideTitle(false);
      setOverrideChannel(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setSubmitting(false);
    }
  };

  const importAll = async () => {
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    setImportMessage(null);
    try {
      const created = await api.importPlaylist(url.trim(), preset);
      setImportMessage(
        `Importing "${created.name}" — videos will appear in your library as they finish.`
      );
      setUrl("");
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setSubmitting(false);
    }
  };

  const percent = Math.round(progress?.progress ?? 0);
  const done = progress?.status === "completed";
  const failed = progress?.status === "error";
  const isPlaylist = preview?.is_playlist ?? false;

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Download</h1>
      <p className="mb-6 text-sm text-gray-400">
        Paste a YouTube or other supported link. The video is saved to your
        library with metadata and a thumbnail. Playlist links can be imported in
        full.
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
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=..."
            className="w-full rounded-lg border border-ink-700 bg-ink-950 px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 outline-none focus:border-accent"
          />
        </div>

        {previewing && (
          <p className="text-xs text-gray-500">Reading link...</p>
        )}

        {preview && !isPlaylist && (
          <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-950 p-4">
            <div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={overrideTitle}
                  onChange={(e) => setOverrideTitle(e.target.checked)}
                  className="accent-accent"
                />
                Override title
              </label>
              {overrideTitle ? (
                <input
                  value={titleValue}
                  onChange={(e) => setTitleValue(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                />
              ) : (
                <p className="mt-1 truncate text-xs text-gray-500">
                  {preview.title ?? "Unknown title"}
                </p>
              )}
            </div>

            <div>
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <input
                  type="checkbox"
                  checked={overrideChannel}
                  onChange={(e) => setOverrideChannel(e.target.checked)}
                  className="accent-accent"
                />
                Override channel
              </label>
              {overrideChannel ? (
                <>
                  <input
                    value={channelValue}
                    onChange={(e) => setChannelValue(e.target.value)}
                    list="known-channels"
                    className="mt-2 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
                  />
                  <datalist id="known-channels">
                    {channels.map((c) => (
                      <option key={c.channel} value={c.channel} />
                    ))}
                  </datalist>
                </>
              ) : (
                <p className="mt-1 truncate text-xs text-gray-500">
                  {preview.channel ?? "Unknown channel"}
                </p>
              )}
            </div>
          </div>
        )}

        {preview && isPlaylist && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-4 text-sm text-gray-300">
            <p className="font-medium text-accent">
              Playlist detected: {preview.title ?? "Untitled"}
            </p>
            <p className="mt-1 text-xs text-gray-400">
              {preview.entry_count ?? 0} video
              {preview.entry_count === 1 ? "" : "s"}. Use “Download all” to import
              the whole playlist.
            </p>
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
            {presets.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p] ?? p}
              </option>
            ))}
          </select>
        </div>

        {isPlaylist ? (
          <button
            type="button"
            onClick={importAll}
            disabled={submitting || !url.trim()}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting..." : "Download all"}
          </button>
        ) : (
          <button
            type="submit"
            disabled={submitting || !url.trim()}
            className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Starting..." : "Download"}
          </button>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
        {importMessage && <p className="text-sm text-accent">{importMessage}</p>}
      </form>

      {jobId != null && (
        <div className="mt-6 rounded-xl bg-ink-900 p-6 ring-1 ring-ink-700">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-gray-200">
              {progress?.title ?? "Working..."}
            </span>
            <span className="text-gray-400">
              {failed ? "Failed" : done ? "Complete" : `${percent}%`}
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-ink-700">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                failed ? "bg-red-500" : "bg-accent"
              }`}
              style={{ width: `${failed ? 100 : percent}%` }}
            />
          </div>
          {failed && (
            <p className="mt-3 text-sm text-red-400">{progress?.error}</p>
          )}
          {done && progress?.video_id && (
            <Link
              to={`/watch/${progress.video_id}`}
              className="mt-4 inline-block rounded-lg bg-accent/15 px-4 py-2 text-sm font-medium text-accent hover:bg-accent/25"
            >
              Watch now →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
