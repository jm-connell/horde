import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import PlaylistRow from "../components/PlaylistRow";
import ThemedSelect from "../components/ThemedSelect";
import { PRESET_ORDER, presetOptionLabel } from "../presets";
import type { Playlist } from "../types";
import { moveItem } from "../utils";

export default function Playlists() {
  const [params, setParams] = useSearchParams();
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [subscribeUrl, setSubscribeUrl] = useState("");
  const [subscribePreset, setSubscribePreset] = useState("best");
  const [allPresets, setAllPresets] = useState<string[]>([...PRESET_ORDER]);
  const [busy, setBusy] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expandedId = Number(params.get("open")) || null;

  const setExpandedId = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("open", String(id));
    else next.delete("open");
    setParams(next, { replace: true });
  };

  const load = (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    api
      .listPlaylists()
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    api.listPresets().then(setAllPresets).catch(() => undefined);
  }, []);

  const scrolledOpen = useRef<number | null>(null);
  const playlistDragFrom = useRef<number | null>(null);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  useEffect(() => {
    if (loading || !expandedId || scrolledOpen.current === expandedId) return;
    const el = document.getElementById(`playlist-row-${expandedId}`);
    if (!el) return;
    scrolledOpen.current = expandedId;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [expandedId, loading, playlists.length]);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createPlaylist(name.trim());
      setName("");
      setPlaylists((prev) =>
        prev.some((row) => row.id === created.id) ? prev : [...prev, created]
      );
      setExpandedId(created.id);
      load({ silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create playlist");
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async () => {
    if (!subscribeUrl.trim()) return;
    setSubscribing(true);
    setError(null);
    try {
      const created = await api.importPlaylist(subscribeUrl.trim(), subscribePreset, {
        subscribe: true,
      });
      setSubscribeUrl("");
      setPlaylists((prev) =>
        prev.some((row) => row.id === created.id) ? prev : [...prev, created]
      );
      setExpandedId(created.id);
      load({ silent: true });
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not subscribe to playlist"
      );
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Playlists</h1>
      <p className="mb-6 text-sm text-gray-400">
        Create your own lists, or subscribe to a YouTube playlist so new videos
        download automatically.
      </p>

      <div className="mb-6">
        <div className="ui-panel grid gap-6 rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700 md:grid-cols-2">
          <div className="min-w-0">
            <h2 className="mb-3 text-sm font-medium text-gray-200">
              New Horde playlist
            </h2>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
                placeholder="Playlist name"
                className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              />
              <button
                onClick={create}
                disabled={busy || !name.trim()}
                className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="mb-3 text-sm font-medium text-gray-200">
              Subscribe to YouTube playlist
            </h2>
            <div className="flex gap-2">
              <input
                value={subscribeUrl}
                onChange={(e) => setSubscribeUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && subscribe()}
                placeholder="YouTube playlist URL"
                className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              />
              <button
                onClick={subscribe}
                disabled={subscribing || !subscribeUrl.trim()}
                className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                {subscribing ? "Subscribing..." : "Subscribe"}
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="shrink-0 text-sm text-gray-400">
                Max resolution
              </label>
              <ThemedSelect
                aria-label="Max resolution"
                value={subscribePreset}
                options={allPresets.map((p) => ({
                  value: p,
                  label: presetOptionLabel(p, undefined),
                }))}
                onChange={setSubscribePreset}
                className="w-44 shrink-0"
                buttonClassName="w-full py-2"
              />
              <p className="min-w-[10rem] flex-1 text-xs leading-snug text-gray-500">
                Horde periodically checks for and downloads new playlist videos.
              </p>
            </div>
          </div>
        </div>
      </div>

      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {loading ? (
        <LoadingIndicator />
      ) : playlists.length === 0 ? (
        <p className="py-20 text-center text-gray-500">No playlists yet.</p>
      ) : (
        <div className="space-y-2">
          {playlists.map((p) => (
            <PlaylistRow
              key={p.id}
              playlist={p}
              open={expandedId === p.id}
              dragging={draggingId === p.id}
              dragOver={dragOverId === p.id}
              onToggle={() =>
                setExpandedId(expandedId === p.id ? null : p.id)
              }
              onPlaylistDragStart={(id) => {
                playlistDragFrom.current = id;
                setDraggingId(id);
              }}
              onPlaylistDragOver={(id) => {
                if (playlistDragFrom.current != null) setDragOverId(id);
              }}
              onPlaylistDrop={(id) => {
                const fromId = playlistDragFrom.current;
                playlistDragFrom.current = null;
                setDraggingId(null);
                setDragOverId(null);
                if (fromId == null || fromId === id) return;
                const from = playlists.findIndex((row) => row.id === fromId);
                const to = playlists.findIndex((row) => row.id === id);
                const next = moveItem(playlists, from, to);
                if (next === playlists) return;
                setPlaylists(next);
                void api
                  .reorderPlaylists(next.map((row) => row.id))
                  .catch(() => load({ silent: true }));
              }}
              onPlaylistDragEnd={() => {
                playlistDragFrom.current = null;
                setDraggingId(null);
                setDragOverId(null);
              }}
              onDeleted={() => {
                setExpandedId(null);
                setPlaylists((prev) => prev.filter((row) => row.id !== p.id));
                load({ silent: true });
              }}
              onUpdated={(next) =>
                setPlaylists((prev) =>
                  prev.map((row) =>
                    row.id === next.id
                      ? {
                          ...row,
                          name: next.name,
                          description: next.description,
                          source_type: next.source_type,
                          source_url: next.source_url,
                          subscribed: next.subscribed,
                          quality_preset: next.quality_preset,
                          last_synced_at: next.last_synced_at,
                          sync_error: next.sync_error,
                          item_count: next.item_count,
                          position: next.position,
                          cover_video_id: next.cover_video_id,
                          has_custom_cover: next.has_custom_cover,
                          thumbnail_video_id: next.thumbnail_video_id,
                          has_thumbnail: next.has_thumbnail,
                        }
                      : row
                  )
                )
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
