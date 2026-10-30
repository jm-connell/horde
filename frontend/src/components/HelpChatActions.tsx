import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { ApiError } from "../api/client";
import { useAuth } from "../context/AuthContext";
import { useDownloads } from "../context/DownloadContext";
import { appendCss, clearCssPreview, showCssPreview } from "../cssPreview";
import { customCssSuspended } from "../customCss";
import { useSettings } from "../hooks/useSettings";
import { PRESET_LABELS } from "../presets";
import {
  appSettingsQuery,
  usePresets,
  useUpdateAppSettings,
} from "../queries/app";
import { queryKeys } from "../queries/keys";
import { usePlaylists } from "../queries/playlists";
import type { HelpCatalog, HelpCatalogSetting } from "../types";
import { button } from "./buttons";
import {
  findPage,
  findSetting,
  type HelpAction,
  parseToken,
  personalPatch,
  readKey,
  resolveValue,
  type SettingValue,
  settingHref,
} from "./helpTokens";
import { CheckIcon } from "./icons";
import ThemedSelect from "./ThemedSelect";

const CHIP =
  "inline-flex max-w-full items-baseline gap-1 rounded-md border border-ink-700 bg-ink-950 px-1.5 py-px align-baseline text-[0.95em] font-medium text-accent hover:border-accent focus-visible:border-accent";
const CARD =
  "ui-panel space-y-2 rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs text-gray-300";
const SMALL_BTN = button("secondary", "sm");

/** Seconds a CSS preview stays before it reverts by itself. */
export const CSS_PREVIEW_SECONDS = 20;
/** Fired with a card's id when its preview starts, so the others stop. */
const CSS_PREVIEW_EVENT = "horde:css-preview";

function errorText(err: unknown): string {
  if (err instanceof ApiError || err instanceof Error) return err.message;
  return "That did not work";
}

/**
 * A `[[page:]]`, `[[setting:]]` or `[[video:]]` token as a link that stays in
 * the app. Anything unknown shows as plain text, so a made-up id links nowhere.
 */
export function HelpTokenLink({
  raw,
  catalog,
  onNavigate,
}: {
  raw: string;
  catalog: HelpCatalog | undefined;
  onNavigate: () => void;
}): ReactNode {
  const token = parseToken(raw);
  if (!token) return raw;
  if (token.kind === "setting") {
    const setting = findSetting(catalog, token.id);
    if (!setting) return catalog ? token.id : "…";
    return (
      <Link
        to={settingHref(setting)}
        onClick={onNavigate}
        className={CHIP}
        title={setting.about}
        data-help-link="setting"
      >
        {setting.label}
      </Link>
    );
  }
  if (token.kind === "page") {
    const page = findPage(catalog, token.id);
    if (!page) return catalog ? token.id : "…";
    // The wiki is served beside the app, not by its router.
    if (page.path.startsWith("/wiki")) {
      return (
        <a href={page.path} target="_blank" rel="noreferrer" className={CHIP}>
          {page.label}
        </a>
      );
    }
    return (
      <Link
        to={page.path}
        onClick={onNavigate}
        className={CHIP}
        title={page.about}
        data-help-link="page"
      >
        {page.label}
      </Link>
    );
  }
  if (token.kind === "video") {
    return (
      <Link
        to={`/watch/${token.id}`}
        onClick={onNavigate}
        className={CHIP}
        data-help-link="video"
      >
        {token.title}
      </Link>
    );
  }
  return null;
}

/** The cards for a finished reply's action tokens. */
export function HelpActionCards({
  actions,
  catalog,
  onNavigate,
}: {
  actions: HelpAction[];
  catalog: HelpCatalog | undefined;
  onNavigate: () => void;
}) {
  if (!actions.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {actions.map((action, i) => {
        const key = `${action.kind}-${i}`;
        if (action.kind === "set") {
          const setting = findSetting(catalog, action.id);
          if (!setting) return null;
          return (
            <SettingChangeCard
              key={key}
              setting={setting}
              raw={action.value}
              onNavigate={onNavigate}
            />
          );
        }
        if (action.kind === "download") {
          return (
            <DownloadCard key={key} url={action.url} onNavigate={onNavigate} />
          );
        }
        if (action.kind === "playlist-new") {
          return (
            <NewPlaylistCard
              key={key}
              name={action.name}
              videoIds={action.videoIds}
              onNavigate={onNavigate}
            />
          );
        }
        return (
          <AddToPlaylistCard
            key={key}
            playlistId={action.playlistId}
            videoIds={action.videoIds}
            onNavigate={onNavigate}
          />
        );
      })}
    </div>
  );
}

function Done({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-success">
      <CheckIcon className="h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Failed({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-warning">
      {children}
    </p>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="mr-1 inline-block h-3 w-3 rounded-sm align-[-1px] ring-1 ring-ink-600"
      style={{ backgroundColor: color }}
    />
  );
}

/** "Change X to Y" with Apply, then Undo. */
function SettingChangeCard({
  setting,
  raw,
  onNavigate,
}: {
  setting: HelpCatalogSetting;
  raw: string;
  onNavigate: () => void;
}) {
  const [settings, update] = useSettings();
  const updateApp = useUpdateAppSettings();
  const serverSide = setting.scope !== "personal";
  const app = useQuery({ ...appSettingsQuery(), enabled: serverSide });
  const resolved = resolveValue(setting, raw);
  const [phase, setPhase] = useState<"idle" | "busy" | "done" | "undone">(
    "idle"
  );
  const [undo, setUndo] = useState<(() => Promise<void> | void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = setting.key ?? setting.id;

  const link = (
    <Link to={settingHref(setting)} onClick={onNavigate} className={CHIP}>
      {setting.label}
    </Link>
  );
  if (!resolved.ok) {
    return (
      <div className={CARD}>
        <p>
          {link}: {resolved.reason}
        </p>
      </div>
    );
  }

  const source = serverSide
    ? setting.scope === "ai"
      ? app.data?.ai
      : app.data
    : settings;
  const current = source ? readKey(source, key) : undefined;
  const impliesHeld = Object.entries(setting.implies ?? {}).every(
    ([k, v]) => readKey(settings, k) === v
  );
  const already =
    phase === "idle" &&
    current === resolved.value &&
    (serverSide || impliesHeld);

  const saveServer = async (value: unknown) => {
    await updateApp(
      setting.scope === "ai" ? { ai: { [key]: value } } : { [key]: value }
    );
  };

  const apply = async (value: SettingValue) => {
    setError(null);
    if (!serverSide) {
      const patch = personalPatch(setting, value, settings);
      update(patch.apply);
      setUndo(() => () => update(patch.undo));
      setPhase("done");
      return;
    }
    setPhase("busy");
    try {
      const before = current;
      await saveServer(value);
      setUndo(() => () => saveServer(before));
      setPhase("done");
    } catch (err) {
      setError(errorText(err));
      setPhase("idle");
    }
  };

  const valueText = (
    <strong className="font-semibold text-gray-100">
      {setting.type === "color" && <Swatch color={String(resolved.value)} />}
      {resolved.label}
    </strong>
  );

  return (
    <div className={CARD} data-help-action="set">
      {phase === "done" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Done>
            {setting.label} is now {valueText}.
          </Done>
          {undo && (
            <button
              type="button"
              className={SMALL_BTN}
              onClick={async () => {
                setError(null);
                try {
                  await undo();
                  setPhase("undone");
                } catch (err) {
                  setError(errorText(err));
                }
              }}
            >
              Undo
            </button>
          )}
        </div>
      ) : phase === "undone" ? (
        <p role="status">Undone: {link} is back how it was.</p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            {already ? (
              <>
                {link} is already {valueText}.
              </>
            ) : (
              <>
                Change {link} to {valueText}
                {serverSide && (
                  <span className="text-muted">
                    {" "}
                    for everyone on this server
                  </span>
                )}
              </>
            )}
          </p>
          {!already && (
            <button
              type="button"
              className={button("primary", "sm")}
              disabled={phase === "busy" || (serverSide && !app.data)}
              onClick={() => void apply(resolved.value)}
            >
              {phase === "busy" ? "Applying…" : "Apply"}
            </button>
          )}
        </div>
      )}
      {error && <Failed>{error}</Failed>}
    </div>
  );
}

function DownloadCard({
  url,
  onNavigate,
}: {
  url: string;
  onNavigate: () => void;
}) {
  const { can } = useAuth();
  const { submitDownload } = useDownloads();
  const presets = usePresets();
  const [preset, setPreset] = useState("best");
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  if (!can("download")) return null;

  return (
    <div className={CARD} data-help-action="download">
      <p className="break-all">
        Download <span className="font-mono text-gray-200">{url}</span>
      </p>
      {phase === "done" ? (
        <Done>
          Added to the queue.{" "}
          <Link to="/download" onClick={onNavigate} className={CHIP}>
            Download
          </Link>
        </Done>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <ThemedSelect
            aria-label="Quality"
            size="compact"
            value={preset}
            options={presets.map((p) => ({
              value: p,
              label: PRESET_LABELS[p] ?? p,
            }))}
            onChange={setPreset}
          />
          <button
            type="button"
            className={button("primary", "sm")}
            disabled={phase === "busy"}
            onClick={async () => {
              setError(null);
              setPhase("busy");
              try {
                await submitDownload(url, preset, {});
                setPhase("done");
              } catch (err) {
                setError(errorText(err));
                setPhase("idle");
              }
            }}
          >
            {phase === "busy" ? "Adding…" : "Download"}
          </button>
        </div>
      )}
      {error && <Failed>{error}</Failed>}
    </div>
  );
}

function videoCount(n: number): string {
  return n === 1 ? "1 video" : `${n} videos`;
}

/**
 * The library videos behind the ids a reply named: the ones that exist (in
 * order), and whether every lookup has finished. Made-up ids drop out, so a
 * card never claims a video it will not add.
 */
function useLibraryVideos(ids: number[]) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: queryKeys.videos.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.getVideo(id, { signal }),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const videos = results.flatMap((r) => (r.data ? [r.data] : []));
  return { videos, ready: results.every((r) => !r.isPending) };
}

function VideoList({
  videos,
  onNavigate,
}: {
  videos: { id: number; title: string }[];
  onNavigate: () => void;
}) {
  const shown = videos.slice(0, 6);
  return (
    <ul className="list-disc space-y-0.5 pl-4 marker:text-muted">
      {shown.map((v) => (
        <li key={v.id} className="truncate">
          <Link
            to={`/watch/${v.id}`}
            onClick={onNavigate}
            className="text-gray-200 hover:text-accent"
          >
            {v.title}
          </Link>
        </li>
      ))}
      {videos.length > shown.length && (
        <li className="text-muted">and {videos.length - shown.length} more</li>
      )}
    </ul>
  );
}

function NewPlaylistCard({
  name,
  videoIds,
  onNavigate,
}: {
  name: string;
  videoIds: number[];
  onNavigate: () => void;
}) {
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const { videos, ready } = useLibraryVideos(videoIds);
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  // Kept across a failed add, so trying again fills the same playlist.
  const [created, setCreated] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (ready && !videos.length) {
    return (
      <div className={CARD}>
        <p>None of the videos for “{name}” are in the library.</p>
      </div>
    );
  }
  return (
    <div className={CARD} data-help-action="playlist-new">
      {phase === "done" && created !== null ? (
        <Done>
          Made “{name}” with {videoCount(videos.length)}.{" "}
          <Link
            to={`/playlists?open=${created}`}
            onClick={onNavigate}
            className={CHIP}
          >
            Open it
          </Link>
        </Done>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              Make a playlist{" "}
              <strong className="font-semibold text-gray-100">“{name}”</strong>{" "}
              with {ready ? videoCount(videos.length) : "…"}
              {can("manage_playlists")
                ? " (App-wide: everyone can see it)"
                : " (Private)"}
            </p>
            <button
              type="button"
              className={button("primary", "sm")}
              disabled={phase === "busy" || !ready}
              onClick={async () => {
                setError(null);
                setPhase("busy");
                try {
                  const id = created ?? (await api.createPlaylist(name)).id;
                  setCreated(id);
                  await api.bulkAddToPlaylist(
                    id,
                    videos.map((v) => v.id)
                  );
                  setPhase("done");
                } catch (err) {
                  setError(errorText(err));
                  setPhase("idle");
                } finally {
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.playlists.all,
                  });
                }
              }}
            >
              {phase === "busy"
                ? "Making…"
                : created !== null
                  ? "Try again"
                  : "Make playlist"}
            </button>
          </div>
          {ready && <VideoList videos={videos} onNavigate={onNavigate} />}
        </>
      )}
      {error && <Failed>{error}</Failed>}
    </div>
  );
}

function AddToPlaylistCard({
  playlistId,
  videoIds,
  onNavigate,
}: {
  playlistId: number;
  videoIds: number[];
  onNavigate: () => void;
}) {
  const queryClient = useQueryClient();
  const { editable, isPending } = usePlaylists();
  const playlist = editable.find((p) => p.id === playlistId);
  const { videos, ready } = useLibraryVideos(videoIds);
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (isPending || !ready) return null;
  if (!videos.length) {
    return (
      <div className={CARD}>
        <p>None of those videos are in the library.</p>
      </div>
    );
  }
  if (!playlist) {
    return (
      <div className={CARD}>
        <p>That playlist is not one you can add to.</p>
      </div>
    );
  }
  return (
    <div className={CARD} data-help-action="playlist-add">
      {phase === "done" ? (
        <Done>
          Added {videoCount(videos.length)} to{" "}
          <Link
            to={`/playlists?open=${playlist.id}`}
            onClick={onNavigate}
            className={CHIP}
          >
            {playlist.name}
          </Link>
        </Done>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>
              Add {videoCount(videos.length)} to{" "}
              <strong className="font-semibold text-gray-100">
                “{playlist.name}”
              </strong>
            </p>
            <button
              type="button"
              className={button("primary", "sm")}
              disabled={phase === "busy"}
              onClick={async () => {
                setError(null);
                setPhase("busy");
                try {
                  await api.bulkAddToPlaylist(
                    playlist.id,
                    videos.map((v) => v.id)
                  );
                  setPhase("done");
                  void queryClient.invalidateQueries({
                    queryKey: queryKeys.playlists.all,
                  });
                } catch (err) {
                  setError(errorText(err));
                  setPhase("idle");
                }
              }}
            >
              {phase === "busy" ? "Adding…" : "Add"}
            </button>
          </div>
          <VideoList videos={videos} onNavigate={onNavigate} />
        </>
      )}
      {error && <Failed>{error}</Failed>}
    </div>
  );
}

/**
 * A ```css block from the reply: Preview puts it on the page for
 * `CSS_PREVIEW_SECONDS` with a bar to keep or revert it (Esc reverts too), so
 * a rule that hides the page undoes itself. Keep adds it to the saved CSS.
 */
export function CssPreviewCard({ css }: { css: string }) {
  const previewId = useId();
  const [settings, update] = useSettings();
  const [phase, setPhase] = useState<
    "idle" | "preview" | "kept" | "reverted" | "undone"
  >("idle");
  const [left, setLeft] = useState(CSS_PREVIEW_SECONDS);
  const [before, setBefore] = useState<{
    customCss: string;
    customCssEnabled: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (phase !== "preview") return;
    showCssPreview(previewId, css);
    // One preview at a time: starting this one ends any other.
    window.dispatchEvent(
      new CustomEvent(CSS_PREVIEW_EVENT, { detail: previewId })
    );
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== previewId) setPhase("reverted");
    };
    window.addEventListener(CSS_PREVIEW_EVENT, onOther);
    const timer = window.setInterval(() => setLeft((n) => n - 1), 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setPhase("reverted");
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener(CSS_PREVIEW_EVENT, onOther);
      clearCssPreview(previewId);
    };
  }, [phase, css, previewId]);

  useEffect(() => {
    if (phase === "preview" && left <= 0) setPhase("reverted");
  }, [phase, left]);

  const keep = () => {
    const next = appendCss(settings.customCss, css);
    if (next === null) {
      setError("Your custom CSS would be too long with this added.");
      setPhase("reverted");
      return;
    }
    setBefore({
      customCss: settings.customCss,
      customCssEnabled: settings.customCssEnabled,
    });
    update({ customCss: next, customCssEnabled: true });
    setPhase("kept");
  };

  return (
    <div className={CARD} data-help-action="css">
      {phase === "kept" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Done>
            Added to your custom CSS (and turned it on)
            {customCssSuspended()
              ? ". It stays off in this tab until you turn it back on (?nocss)."
              : "."}
          </Done>
          {before && (
            <button
              type="button"
              className={SMALL_BTN}
              onClick={() => {
                update(before);
                setPhase("undone");
              }}
            >
              Undo
            </button>
          )}
        </div>
      ) : phase === "undone" ? (
        <p role="status">Undone: your custom CSS is back how it was.</p>
      ) : phase === "preview" ? (
        <p role="status">
          Previewing… keep or revert it from the bar at the top.
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p>
            {phase === "reverted"
              ? "Reverted. Nothing was saved."
              : "Try this CSS on the page before keeping it."}
          </p>
          <button
            type="button"
            className={button("primary", "sm")}
            onClick={() => {
              setError(null);
              setLeft(CSS_PREVIEW_SECONDS);
              setPhase("preview");
            }}
          >
            {phase === "reverted" ? "Preview again" : "Preview"}
          </button>
        </div>
      )}
      {error && <Failed>{error}</Failed>}
      {phase === "preview" &&
        createPortal(
          <div
            role="alertdialog"
            aria-label="CSS preview"
            data-horde="css-preview-bar"
            // Inline, so ordinary rules in the CSS being tried do not move or
            // hide it; a rule that still does is undone by the timer and Esc.
            style={{
              position: "fixed",
              top: 12,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 2147483647,
              display: "flex",
            }}
            className="ui-panel ui-panel-legible max-w-[calc(100vw-1.5rem)] flex-wrap items-center gap-3 rounded-xl bg-ink-900 px-4 py-2.5 text-sm text-gray-200 shadow-2xl ring-1 ring-accent/60"
          >
            <span>
              Previewing CSS · reverts in{" "}
              <span className="tabular-nums">{Math.max(left, 0)}</span>s (Esc
              reverts now)
            </span>
            <button
              type="button"
              className={button("primary", "sm")}
              onClick={keep}
            >
              Keep
            </button>
            <button
              type="button"
              className={SMALL_BTN}
              onClick={() => setPhase("reverted")}
            >
              Revert
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
