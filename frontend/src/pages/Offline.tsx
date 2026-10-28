import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import PrivateDownloadsNotice from "../components/PrivateDownloadsNotice";
import { useAuth } from "../context/AuthContext";
import { useConfirm } from "../context/ConfirmContext";
import { deviceAccounts, type AccountRegistry } from "../offline/accounts";
import { connectivity } from "../offline/connectivity";
import type { OfflineItem } from "../offline/db";
import {
  itemProgress,
  useConnectivity,
  useDeviceAccounts,
  useOfflineDownloads,
  useOfflineResumePositions,
} from "../offline/hooks";
import { offlineManager } from "../offline/manager";
import HttpsHelp from "../components/HttpsHelp";
import { formatDuration, formatSize } from "../utils";

function thumbUrl(item: OfflineItem): string {
  return item.videoId < 0
    ? `/api/thumbnails/${item.videoId}`
    : `/api/thumbnails/${item.videoId}?size=sm`;
}

function Thumb({ item, className }: { item: OfflineItem; className: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`relative overflow-hidden bg-ink-800 ${className}`}>
      {failed ? null : (
        <img
          decoding="async"
          src={thumbUrl(item)}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

/** "Saved by jon" for a download another account saved; null for your own. */
function savedBy(
  item: OfflineItem,
  viewer: number | undefined,
  accounts: AccountRegistry
): string | null {
  if (item.owner === undefined || item.owner === viewer) return null;
  return `Saved by ${accounts.get(item.owner)?.username ?? item.ownerName ?? "another account"}`;
}

function useRemove() {
  const confirm = useConfirm();
  return async (item: OfflineItem) => {
    const ok = await confirm({
      title: "Remove offline download?",
      body: `"${item.video.title}" will be removed from this device.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (ok) await offlineManager.remove(item.videoId);
  };
}

const btn =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent";

function DownloadingRow({
  item,
  liveBytes,
  savedByLabel,
  onRemove,
}: {
  item: OfflineItem;
  liveBytes: ReadonlyMap<number, number>;
  savedByLabel: string | null;
  onRemove: (item: OfflineItem) => void;
}) {
  const { progress, bytes } = itemProgress(item, liveBytes);
  const pct = Math.round(Math.min(1, progress) * 100);
  const status =
    item.status === "queued"
      ? "Waiting"
      : item.status === "paused"
        ? "Paused"
        : item.status === "error"
          ? `Error: ${item.error || "download failed"}`
          : "Downloading";
  return (
    <li className="ui-panel flex gap-3 rounded-lg border border-ink-700 bg-ink-900 p-3">
      <Thumb
        item={item}
        className="h-14 w-24 shrink-0 rounded-lg sm:h-16 sm:w-28"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-gray-100">
          {item.video.title}
        </p>
        {item.video.channel ? (
          <p className="truncate text-xs text-muted">{item.video.channel}</p>
        ) : null}
        {savedByLabel ? (
          <p className="truncate text-xs text-muted">{savedByLabel}</p>
        ) : null}
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <p
          className={`mt-1 text-xs ${item.status === "error" ? "text-red-400" : "text-gray-400"}`}
        >
          {status}
          {item.totalBytes
            ? ` · ${formatSize(bytes) || "0 B"} / ${formatSize(item.totalBytes)}`
            : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {item.status === "downloading" || item.status === "queued" ? (
            <button
              className={btn}
              onClick={() => offlineManager.pause(item.videoId)}
            >
              Pause
            </button>
          ) : null}
          {item.status === "paused" ? (
            <button
              className={btn}
              onClick={() => offlineManager.resume(item.videoId)}
            >
              Resume
            </button>
          ) : null}
          {item.status === "error" ? (
            <button
              className={btn}
              onClick={() => void offlineManager.download(item.video)}
            >
              Retry
            </button>
          ) : null}
          <button
            className={`${btn} border-red-500/40! text-red-400! hover:bg-red-500/10!`}
            onClick={() => onRemove(item)}
          >
            Remove
          </button>
        </div>
      </div>
    </li>
  );
}

function DownloadedCard({
  item,
  positionSec,
  savedByLabel,
  onRemove,
}: {
  item: OfflineItem;
  /** The signed-in account's place in it, on this device. */
  positionSec: number;
  savedByLabel: string | null;
  onRemove: (item: OfflineItem) => void;
}) {
  const v = item.video;
  const dur = v.duration_sec;
  const resume =
    positionSec > 0 && dur ? Math.min(100, (positionSec / dur) * 100) : 0;
  return (
    <li className="group relative">
      <Link to={`/watch/${item.videoId}`} className="block">
        <div className="relative">
          <Thumb item={item} className="aspect-video w-full rounded-lg" />
          {dur ? (
            <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/80 px-1.5 py-0.5 text-xs text-white">
              {formatDuration(dur)}
            </span>
          ) : null}
          {resume > 0 ? (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
              <div
                className="h-full bg-accent"
                style={{ width: `${resume}%` }}
              />
            </div>
          ) : null}
        </div>
        <p className="mt-2 line-clamp-2 pr-7 text-sm font-medium text-gray-100">
          {v.title}
        </p>
        {v.channel ? (
          <p className="truncate text-xs text-muted">{v.channel}</p>
        ) : null}
        {savedByLabel ? (
          <p className="truncate text-xs text-muted">{savedByLabel}</p>
        ) : null}
      </Link>
      <button
        type="button"
        aria-label={`Remove ${v.title} from this device`}
        title="Remove download"
        onClick={() => onRemove(item)}
        className="absolute bottom-0 right-0 rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400"
      >
        <svg
          viewBox="0 0 24 24"
          className="h-4 w-4"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6" />
        </svg>
      </button>
    </li>
  );
}

export default function OfflinePage({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const snap = useOfflineDownloads();
  const positions = useOfflineResumePositions();
  const conn = useConnectivity();
  const accounts = useDeviceAccounts();
  const viewer = useAuth().user?.id;
  const remove = useRemove();
  const [quota, setQuota] = useState<{ usage?: number; quota?: number } | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const est = await navigator.storage?.estimate?.();
        if (!cancelled && est) setQuota({ usage: est.usage, quota: est.quota });
      } catch {
        /* unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [snap.items.length]);

  const { active, done, totalBytes } = useMemo(() => {
    const sorted = [...snap.items].sort((a, b) => b.createdAt - a.createdAt);
    const done = sorted.filter((i) => i.status === "complete");
    return {
      active: sorted.filter((i) => i.status !== "complete"),
      done: done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
      totalBytes: done.reduce((n, i) => n + i.totalBytes, 0),
    };
  }, [snap.items]);

  const me = viewer === undefined ? undefined : accounts.get(viewer);
  const needsUnlockSetup =
    !!me &&
    !me.shareDownloads &&
    !me.verifier &&
    snap.items.some((i) => i.owner === viewer);

  const summary = [
    `${formatSize(totalBytes) || "0 B"} used by downloads`,
    quota?.usage != null && quota.quota
      ? `${formatSize(quota.usage)} of ${formatSize(quota.quota)} browser storage used`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      data-horde="offline-page"
      className="mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6"
    >
      {embedded ? (
        conn.status === "offline" ? (
          <div className="ui-panel mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
            <p className="min-w-0 flex-1 text-sm text-gray-200">
              You’re offline — showing videos downloaded to this device.
            </p>
            <button
              className={btn}
              disabled={conn.reconnecting}
              onClick={() => void connectivity.reconnect()}
            >
              {conn.reconnecting ? "Reconnecting…" : "Reconnect"}
            </button>
          </div>
        ) : null
      ) : (
        <h1 className="mb-1 text-xl font-semibold text-gray-100">
          Offline videos
        </h1>
      )}
      <p className="mb-5 text-xs text-muted">{summary}</p>

      <PrivateDownloadsNotice groups={snap.hidden} />

      {needsUnlockSetup ? (
        <div
          data-horde="offline-unlock-hint"
          className="ui-panel mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3"
        >
          <p className="min-w-0 flex-1 text-sm text-gray-200">
            Offline unlock isn’t set up for your private downloads. If someone
            else is signed in on this device and you have no connection, you
            won’t be able to open them.
          </p>
          {conn.status !== "offline" && viewer !== undefined ? (
            <button
              type="button"
              className={btn}
              onClick={() => deviceAccounts.requestSetup(viewer)}
            >
              Set up offline unlock
            </button>
          ) : null}
        </div>
      ) : null}

      {snap.unsupported ? (
        <div className="ui-panel rounded-lg border border-amber-500/30 bg-ink-900 p-4">
          <p className="mb-2 font-medium text-gray-100">
            Offline downloads aren’t available on this connection
          </p>
          <HttpsHelp />
        </div>
      ) : null}

      {!snap.unsupported && snap.ready && snap.items.length === 0 ? (
        <div className="py-16 text-center">
          <p className="text-lg text-gray-200">
            {snap.hidden.length > 0
              ? "No downloads for this account yet"
              : "No downloads yet"}
          </p>
          <p className="mt-1 text-sm text-muted">
            Tap Download on any video to save it for offline viewing.
          </p>
        </div>
      ) : null}

      {active.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
            Downloading
          </h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {active.map((item) => (
              <DownloadingRow
                key={item.videoId}
                item={item}
                liveBytes={snap.liveBytes}
                savedByLabel={savedBy(item, viewer, accounts)}
                onRemove={remove}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {done.length > 0 ? (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-400">
            Downloaded
          </h2>
          <ul className="grid grid-cols-1 gap-x-4 gap-y-6 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {done.map((item) => (
              <DownloadedCard
                key={item.videoId}
                item={item}
                positionSec={positions.get(item.videoId) ?? 0}
                savedByLabel={savedBy(item, viewer, accounts)}
                onRemove={remove}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
