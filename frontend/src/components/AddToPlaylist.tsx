import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";
import type { Playlist } from "../types";

export default function AddToPlaylist({ videoId }: { videoId: number }) {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const flip = useFlipMenu(open, 320);

  useEffect(() => {
    if (!open) return;
    api.listPlaylists().then(setPlaylists).catch(() => undefined);
  }, [open]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const add = async (playlistId: number, name: string) => {
    try {
      await api.addToPlaylist(playlistId, videoId);
      setStatus(`Added to ${name}`);
      setTimeout(() => setStatus(null), 2000);
      setOpen(false);
    } catch {
      setStatus("Failed to add");
    }
  };

  const createAndAdd = async () => {
    if (!newName.trim()) return;
    try {
      const pl = await api.createPlaylist(newName.trim());
      setNewName("");
      await add(pl.id, pl.name);
    } catch {
      setStatus("Failed to create");
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="ui-panel rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
      >
        + Playlist
      </button>
      {status && !open && (
        <span className="ml-2 text-xs text-accent">{status}</span>
      )}
      <FlipMenuPanel open={open} flip={flip} align="left" className="w-64 p-2">
        <div className="max-h-48 overflow-y-auto">
          {playlists.length === 0 ? (
            <p className="px-2 py-1 text-xs text-gray-500">No playlists yet.</p>
          ) : (
            playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => add(p.id, p.name)}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-gray-200 hover:bg-ink-700"
              >
                {p.name}
              </button>
            ))
          )}
        </div>
        <div className="mt-2 flex gap-1 border-t border-ink-700 pt-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
            placeholder="New playlist"
            className="min-w-0 flex-1 rounded border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-gray-100 outline-none focus:border-accent"
          />
          <button
            onClick={createAndAdd}
            className="shrink-0 rounded bg-accent px-2 py-1 text-xs font-semibold text-ink-950 hover:bg-accent-soft"
          >
            Add
          </button>
        </div>
      </FlipMenuPanel>
    </div>
  );
}
