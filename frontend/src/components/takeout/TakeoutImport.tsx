import { useRef, useState } from "react";
import { useSettings } from "../../hooks/useSettings";
import { useApplyTakeout, useImportTakeout } from "../../queries/takeout";
import type {
  TakeoutApplyResult,
  TakeoutImportResult,
  TakeoutPlaylist,
  TakeoutSubscription,
} from "../../types";
import { Toggle } from "../../pages/settings/ui";
import { button } from "../buttons";
import TakeoutChoiceList from "./TakeoutChoiceList";

const ACCEPT = ".zip,.json,.html,.csv";

type Stage =
  | { kind: "pick" }
  | { kind: "uploading"; pct: number }
  | { kind: "review"; result: TakeoutImportResult }
  | { kind: "done"; result: TakeoutImportResult; applied: TakeoutApplyResult };

function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/** The switch that adds YouTube views to the History stats (a per-account setting). */
export function TakeoutStatsToggle() {
  const [settings, update] = useSettings();
  return (
    <label className="flex items-center justify-between gap-4">
      <span>
        <span className="block text-sm font-medium text-gray-200">
          Include YouTube in History stats
        </span>
        <span className="block text-xs text-muted">
          Views count toward videos watched, active days, top channels and when
          you watch. Takeout doesn’t record watch time, so it adds none.
        </span>
      </span>
      <Toggle
        checked={settings.historyIncludeYoutube}
        onChange={() =>
          update({ historyIncludeYoutube: !settings.historyIncludeYoutube })
        }
      />
    </label>
  );
}

function Steps() {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
      <li>
        Open{" "}
        <a
          href="https://takeout.google.com/"
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent hover:underline"
        >
          Google Takeout
        </a>
        , choose <span className="text-gray-300">Deselect all</span>, then tick{" "}
        <span className="text-gray-300">YouTube and YouTube Music</span>.
      </li>
      <li>
        Under <span className="text-gray-300">All YouTube data included</span>,
        keep history, subscriptions and playlists. Leave out videos so the
        export stays small. JSON for history is best; HTML works too.
      </li>
      <li>
        Export once, download the .zip (every part if there are several) and
        choose it here. Importing a newer export later only adds what’s new.
      </li>
    </ol>
  );
}

/**
 * Import a Google Takeout export: upload, then choose which subscriptions to
 * follow and which playlists to copy. The watch history is stored on upload.
 * Everything lands on the signed-in account only.
 */
export default function TakeoutImport({
  onFinished,
}: {
  /** Called after the last step, with nothing left to do. */
  onFinished?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [subs, setSubs] = useState<Set<string>>(new Set());
  const [lists, setLists] = useState<Set<string>>(new Set());
  const importTakeout = useImportTakeout();
  const applyTakeout = useApplyTakeout();

  const upload = async () => {
    if (files.length === 0) return;
    setError(null);
    setStage({ kind: "uploading", pct: 0 });
    try {
      const result = await importTakeout.mutateAsync({
        files,
        onProgress: (pct) => setStage({ kind: "uploading", pct }),
      });
      setSubs(
        new Set(
          result.subscriptions
            .filter((s) => s.status === "new")
            .map((s) => s.channel_url)
        )
      );
      setLists(
        new Set(
          result.playlists.filter((p) => p.new_videos > 0).map(playlistKey)
        )
      );
      setStage({ kind: "review", result });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStage({ kind: "pick" });
    }
  };

  const apply = async (result: TakeoutImportResult) => {
    setError(null);
    try {
      const applied = await applyTakeout.mutateAsync({
        subscriptions: result.subscriptions
          .filter((s) => subs.has(s.channel_url))
          .map((s) => ({
            channel_url: s.channel_url,
            channel_name: s.channel_name,
          })),
        playlists: result.playlists
          .filter((p) => lists.has(playlistKey(p)))
          .map((p) => ({
            title: p.title,
            playlist_id: p.playlist_id,
            video_ids: p.video_ids,
          })),
      });
      setStage({ kind: "done", result, applied });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    }
  };

  const reset = () => {
    setFiles([]);
    setStage({ kind: "pick" });
    if (inputRef.current) inputRef.current.value = "";
  };

  if (stage.kind === "pick" || stage.kind === "uploading") {
    const uploading = stage.kind === "uploading";
    return (
      <div className="space-y-4">
        <Steps />
        <div className="flex flex-wrap items-center gap-3">
          <label
            className={`${button("secondary", "sm")} cursor-pointer focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent`}
          >
            {files.length > 0 ? "Choose other files" : "Choose export"}
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPT}
              disabled={uploading}
              className="sr-only"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">
            {files.length === 0
              ? "No file chosen"
              : files.map((f) => f.name).join(", ")}
          </span>
          <button
            type="button"
            className={button("primary", "sm")}
            disabled={files.length === 0 || uploading}
            onClick={() => void upload()}
          >
            {uploading ? "Importing…" : "Import"}
          </button>
        </div>
        {uploading && (
          <div>
            <div
              className="h-1.5 overflow-hidden rounded-full bg-ink-700"
              role="progressbar"
              aria-label="Upload progress"
              aria-valuenow={stage.pct}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className="h-full w-full origin-left bg-accent transition-transform duration-200 ease-linear"
                style={{ transform: `scaleX(${stage.pct / 100})` }}
              />
            </div>
            <p className="mt-1 text-xs text-muted" aria-live="polite">
              {stage.pct < 100
                ? `Uploading… ${stage.pct}%`
                : "Reading your export…"}
            </p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (stage.kind === "done") {
    const { applied } = stage;
    const parts = [
      applied.followed > 0 && `followed ${plural(applied.followed, "channel")}`,
      applied.playlists_created > 0 &&
        `created ${plural(applied.playlists_created, "playlist")}`,
      applied.playlists_updated > 0 &&
        `updated ${plural(applied.playlists_updated, "playlist")}`,
    ].filter(Boolean);
    return (
      <div className="space-y-4">
        <HistorySummary result={stage.result} />
        <p className="text-sm text-gray-200">
          {parts.length > 0
            ? `Done: ${parts.join(", ")}${
                applied.videos_added > 0
                  ? ` (${plural(applied.videos_added, "video")} added)`
                  : ""
              }.`
            : "Done. Nothing else to import."}
        </p>
        <div className="flex flex-wrap gap-2">
          {onFinished && (
            <button
              type="button"
              className={button("primary", "sm")}
              onClick={onFinished}
            >
              Close
            </button>
          )}
          <button
            type="button"
            className={button("secondary", "sm")}
            onClick={reset}
          >
            Import another export
          </button>
        </div>
      </div>
    );
  }

  const { result } = stage;
  const nothingToChoose =
    result.subscriptions.length === 0 && result.playlists.length === 0;
  return (
    <div className="space-y-5">
      <HistorySummary result={result} />
      {result.subscriptions.length > 0 && (
        <TakeoutChoiceList<TakeoutSubscription>
          title="Subscriptions"
          description="Follow these channels in Horde (just for your account)."
          items={result.subscriptions}
          itemKey={(s) => s.channel_url}
          label={(s) => s.channel_name || s.channel_url}
          note={(s) =>
            s.status === "following"
              ? "Following"
              : s.status === "unfollowed"
                ? "You unfollowed this"
                : null
          }
          locked={(s) => s.status === "following"}
          selected={subs}
          onChange={setSubs}
        />
      )}
      {result.playlists.length > 0 && (
        <TakeoutChoiceList<TakeoutPlaylist>
          title="Playlists"
          description="Copy them as private playlists. Videos you haven’t downloaded play from YouTube."
          items={result.playlists}
          itemKey={playlistKey}
          label={(p) => p.title}
          note={(p) =>
            p.existing_playlist_id == null
              ? plural(p.video_ids.length, "video")
              : p.new_videos > 0
                ? `Imported before · ${p.new_videos.toLocaleString()} new`
                : "Imported before · up to date"
          }
          locked={(p) => p.new_videos === 0}
          selected={lists}
          onChange={setLists}
        />
      )}
      <TakeoutStatsToggle />
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {nothingToChoose ? (
          <button
            type="button"
            className={button("primary", "sm")}
            onClick={onFinished ?? reset}
          >
            {onFinished ? "Done" : "Import another export"}
          </button>
        ) : (
          <button
            type="button"
            className={button("primary", "sm")}
            disabled={applyTakeout.isPending}
            onClick={() => void apply(result)}
          >
            {applyTakeout.isPending
              ? "Importing…"
              : `Import selected (${(subs.size + lists.size).toLocaleString()})`}
          </button>
        )}
      </div>
    </div>
  );
}

function playlistKey(p: TakeoutPlaylist): string {
  return p.playlist_id ?? `title:${p.title}`;
}

function HistorySummary({ result }: { result: TakeoutImportResult }) {
  const { history } = result;
  if (!result.found_history) {
    return (
      <p className="text-sm text-muted">
        This export has no watch history. Subscriptions and playlists can still
        be imported.
      </p>
    );
  }
  const since = monthYear(history.first_watched_at);
  const already = result.views_in_file - result.new_views;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-800/50 px-3 py-2.5">
      <p className="text-sm text-gray-200">
        Watch history:{" "}
        <span className="font-medium">
          {plural(result.new_views, "new view")}
        </span>{" "}
        imported
        {already > 0 && (
          <span className="text-muted">
            {" "}
            ({already.toLocaleString()} already here)
          </span>
        )}
        .
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {plural(history.distinct_videos, "video")} watched on YouTube
        {since ? ` since ${since}` : ""}. They’re marked as watched on channel
        pages and shape your recommendations; they don’t appear in History.
      </p>
    </div>
  );
}
