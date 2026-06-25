import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useDownloadProgress } from "../hooks/useDownloadProgress";

export default function Download() {
  const [url, setUrl] = useState("");
  const [preset, setPreset] = useState("best");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [jobId, setJobId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const progress = useDownloadProgress(jobId);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const job = await api.createDownload(url.trim(), preset);
      setJobId(job.id);
      setUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setSubmitting(false);
    }
  };

  const percent = Math.round(progress?.progress ?? 0);
  const done = progress?.status === "completed";
  const failed = progress?.status === "error";

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Download</h1>
      <p className="mb-6 text-sm text-gray-400">
        Paste a YouTube or other supported link. The video is saved to your
        library with metadata and a thumbnail.
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
                {p}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={submitting || !url.trim()}
          className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? "Starting..." : "Download"}
        </button>

        {error && <p className="text-sm text-red-400">{error}</p>}
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
