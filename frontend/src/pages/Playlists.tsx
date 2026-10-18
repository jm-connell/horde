import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { describeError } from "../apiErrors";
import { useToast } from "../context/ToastContext";
import { usePresets } from "../queries/app";
import { queryKeys } from "../queries/keys";
import { setPlaylistList, usePlaylists } from "../queries/playlists";
import LoadingIndicator from "../components/LoadingIndicator";
import PlaylistRow from "../components/PlaylistRow";
import ThemedSelect from "../components/ThemedSelect";
import type { Playlist } from "../types";
import { PRESET_ORDER, presetOptionLabel } from "../presets";
import { moveItem } from "../utils";

export default function Playlists() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { showError } = useToast();
  const { playlists, isPending: loading } = usePlaylists();
  const [name, setName] = useState("");
  const [subscribeUrl, setSubscribeUrl] = useState("");
  const [subscribePreset, setSubscribePreset] = useState("best");
  const allPresets = usePresets([...PRESET_ORDER]);

  const expandedId = Number(params.get("open")) || null;

  const setExpandedId = (id: number | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("open", String(id));
    else next.delete("open");
    setParams(next, { replace: true });
  };

  const load = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.playlists.list });

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

  const addToList = (created: Playlist) => {
    setPlaylistList(queryClient, (prev) =>
      prev.some((row) => row.id === created.id) ? prev : [...prev, created]
    );
    setExpandedId(created.id);
    void load();
  };

  const createMutation = useMutation({
    mutationFn: (newName: string) => api.createPlaylist(newName),
    onSuccess: (created) => {
      setName("");
      addToList(created);
    },
    onError: (err) =>
      showError(`Could not create playlist: ${describeError(err)}`),
  });
  const busy = createMutation.isPending;
  const create = () => {
    if (name.trim()) createMutation.mutate(name.trim());
  };

  const subscribeMutation = useMutation({
    mutationFn: (v: { url: string; preset: string }) =>
      api.importPlaylist(v.url, v.preset, { subscribe: true }),
    onSuccess: (created) => {
      setSubscribeUrl("");
      addToList(created);
    },
    onError: (err) =>
      showError(`Could not subscribe to playlist: ${describeError(err)}`),
  });
  const subscribing = subscribeMutation.isPending;
  const subscribe = () => {
    if (subscribeUrl.trim()) {
      subscribeMutation.mutate({
        url: subscribeUrl.trim(),
        preset: subscribePreset,
      });
    }
  };

  const reorderMutation = useMutation({
    mutationFn: (ids: number[]) => api.reorderPlaylists(ids),
    onError: () => void load(),
  });

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Playlists</h1>
      <p className="mb-6 text-sm text-gray-400">
        Create your own lists, or subscribe to a YouTube playlist so new videos
        download automatically.
      </p>

      {can("manage_playlists") && (
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
                  className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
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
            {can("download") && (
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
                    className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-hidden focus:border-accent"
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
                  <span className="shrink-0 text-sm text-gray-400">
                    Max resolution
                  </span>
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
                  <p className="min-w-40 flex-1 text-xs leading-snug text-muted">
                    Horde periodically checks for and downloads new playlist
                    videos.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <LoadingIndicator />
      ) : playlists.length === 0 ? (
        <p className="py-20 text-center text-muted">No playlists yet.</p>
      ) : (
        <div className="space-y-2">
          {playlists.map((p) => (
            <PlaylistRow
              key={p.id}
              playlist={p}
              open={expandedId === p.id}
              dragging={draggingId === p.id}
              dragOver={dragOverId === p.id}
              onToggle={() => setExpandedId(expandedId === p.id ? null : p.id)}
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
                setPlaylistList(queryClient, () => next);
                reorderMutation.mutate(next.map((row) => row.id));
              }}
              onPlaylistDragEnd={() => {
                playlistDragFrom.current = null;
                setDraggingId(null);
                setDragOverId(null);
              }}
              onDeleted={() => {
                setExpandedId(null);
                setPlaylistList(queryClient, (prev) =>
                  prev.filter((row) => row.id !== p.id)
                );
                void load();
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
