import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../queries/keys";
import { usePlaylists } from "../queries/playlists";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { MenuScroll } from "./MenuFlyout";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";
import { LockIcon } from "./playlistChrome";

const defaultButtonClass =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700";

/** Adds a library video (`videoId`) or, from a stream's page, its link (`streamUrl`). */
export default function AddToPlaylist({
  videoId,
  streamUrl,
  label = "+ Playlist",
  buttonClassName = defaultButtonClass,
  onOpenChange,
}: {
  videoId?: number;
  streamUrl?: string;
  label?: string;
  buttonClassName?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { editable: playlists } = usePlaylists(open);
  const [status, setStatus] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const { flip, anchorRef } = useFlipMenu(open, 320);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-horde='flip-menu']")) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, anchorRef]);

  const add = async (playlistId: number, name: string) => {
    try {
      if (videoId != null) await api.addToPlaylist(playlistId, videoId);
      else if (streamUrl) await api.addUrlToPlaylist(playlistId, streamUrl);
      else return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.playlists.all,
      });
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
    <div className="relative shrink-0" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={buttonClassName}
      >
        {label}
      </button>
      {status && !open && (
        <span className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 whitespace-nowrap text-xs text-accent">
          {status}
        </span>
      )}
      <FlipMenuPanel
        open={open}
        flip={flip}
        align="left"
        className="w-64"
        menu={{
          kind: "popup",
          label: "Add to playlist",
          onClose: () => setOpen(false),
          triggerRef,
        }}
      >
        <MenuScroll className="max-h-48" revision={playlists.length}>
          {playlists.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">No playlists yet.</p>
          ) : (
            playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => add(p.id, p.name)}
                className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm text-gray-200 hover:bg-ink-700"
              >
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {p.visibility === "private" && (
                  <span title="Private" className="shrink-0 text-muted">
                    <LockIcon />
                    <span className="sr-only">Private</span>
                  </span>
                )}
              </button>
            ))
          )}
        </MenuScroll>
        <div className="flex gap-1 border-t border-ink-700 p-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
            placeholder="New playlist"
            className="min-w-0 flex-1 rounded-sm border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-gray-100 outline-hidden focus:border-accent"
          />
          <button
            onClick={createAndAdd}
            className="shrink-0 rounded-sm bg-accent px-2 py-1 text-xs font-semibold text-on-accent hover:bg-accent-soft"
          >
            Add
          </button>
        </div>
      </FlipMenuPanel>
    </div>
  );
}
