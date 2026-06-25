import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Playlist } from "../types";

export default function Playlists() {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [preset, setPreset] = useState("best");
  const [presets, setPresets] = useState<string[]>(["best"]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api
      .listPlaylists()
      .then(setPlaylists)
      .catch(() => setPlaylists([]))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);
  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => undefined);
  }, []);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.createPlaylist(name.trim());
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create playlist");
    } finally {
      setBusy(false);
    }
  };

  const importPlaylist = async () => {
    if (!importUrl.trim()) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const created = await api.importPlaylist(importUrl.trim(), preset);
      setImportUrl("");
      setMessage(
        `Importing "${created.name}" — videos will appear as they finish downloading.`
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold text-gray-100">Playlists</h1>
      <p className="mb-6 text-sm text-gray-400">
        Create your own playlists or import a public YouTube playlist.
      </p>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700">
          <h2 className="mb-3 text-sm font-medium text-gray-200">New playlist</h2>
          <div className="flex gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="Playlist name"
              className="flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            />
            <button
              onClick={create}
              disabled={busy || !name.trim()}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>

        <div className="rounded-xl bg-ink-900 p-5 ring-1 ring-ink-700">
          <h2 className="mb-3 text-sm font-medium text-gray-200">
            Import from YouTube
          </h2>
          <div className="flex flex-col gap-2">
            <input
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://www.youtube.com/playlist?list=..."
              className="w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
            />
            <div className="flex gap-2">
              <select
                value={preset}
                onChange={(e) => setPreset(e.target.value)}
                className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-gray-100 outline-none focus:border-accent"
              >
                {presets.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button
                onClick={importPlaylist}
                disabled={busy || !importUrl.trim()}
                className="flex-1 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 hover:bg-accent-soft disabled:opacity-50"
              >
                Import
              </button>
            </div>
          </div>
        </div>
      </div>

      {message && <p className="mb-4 text-sm text-accent">{message}</p>}
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}

      {loading ? (
        <p className="py-20 text-center text-gray-500">Loading...</p>
      ) : playlists.length === 0 ? (
        <p className="py-20 text-center text-gray-500">No playlists yet.</p>
      ) : (
        <div className="space-y-2">
          {playlists.map((p) => (
            <Link
              key={p.id}
              to={`/playlists/${p.id}`}
              className="flex items-center justify-between rounded-xl bg-ink-900 px-5 py-4 ring-1 ring-ink-700 transition-colors hover:ring-accent/60"
            >
              <div className="min-w-0">
                <h3 className="truncate font-semibold text-gray-100">{p.name}</h3>
                <p className="text-xs text-gray-500">
                  {p.item_count} video{p.item_count === 1 ? "" : "s"}
                </p>
              </div>
              <span
                className={`ml-3 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  p.source_type === "youtube"
                    ? "bg-red-500/15 text-red-300"
                    : "bg-accent/15 text-accent"
                }`}
              >
                {p.source_type === "youtube" ? "YouTube" : "Custom"}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
