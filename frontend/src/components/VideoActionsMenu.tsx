import { useEffect, useRef, useState } from "react";
import { downloadFileUrl } from "../api";
import type { Video } from "../types";
import { effectiveSourceUrl } from "../utils";

interface Props {
  video: Video;
  onEdit: () => void;
  onAddNote: () => void;
  onChangeResolution: () => void;
  onDelete: () => void;
}

export default function VideoActionsMenu({
  video,
  onEdit,
  onAddNote,
  onChangeResolution,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const canChangeResolution = Boolean(effectiveSourceUrl(video));

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open]);

  const downloadFile = () => {
    const a = document.createElement("a");
    a.href = downloadFileUrl(video.id);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };

  const itemClass =
    "block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-ink-700";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-200 hover:bg-ink-700"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        •••
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-52 overflow-hidden rounded-lg bg-ink-800 py-1 shadow-2xl ring-1 ring-ink-600">
          <button
            onClick={() => {
              onEdit();
              setOpen(false);
            }}
            className={itemClass}
          >
            Edit
          </button>
          <button
            onClick={() => {
              onAddNote();
              setOpen(false);
            }}
            className={itemClass}
          >
            Add note
          </button>
          {canChangeResolution && (
            <button
              onClick={() => {
                onChangeResolution();
                setOpen(false);
              }}
              className={itemClass}
            >
              Change resolution
            </button>
          )}
          <button onClick={downloadFile} className={itemClass}>
            Download file
          </button>
          {video.source_url && (
            <a
              href={video.source_url}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              className={itemClass}
            >
              Source link ↗
            </a>
          )}
          <button
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
            className="block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-500/10"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
