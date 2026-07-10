import { useEffect, useState } from "react";
import { api, downloadFileUrl } from "../api";
import { useSettings } from "../hooks/useSettings";
import { useToast } from "../context/ToastContext";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";
import type { Video } from "../types";
import { effectiveSourceUrl } from "../utils";

interface Props {
  video: Video;
  onEdit: () => void;
  onAddNote: () => void;
  onChangeResolution: () => void;
  onNormalizeVolume?: () => void;
  onDelete: () => void;
  onVideoUpdated?: (video: Video) => void;
}

export default function VideoActionsMenu({
  video,
  onEdit,
  onAddNote,
  onChangeResolution,
  onNormalizeVolume,
  onDelete,
  onVideoUpdated,
}: Props) {
  const [open, setOpen] = useState(false);
  const [settings, update] = useSettings();
  const { showToast } = useToast();
  const { flip, anchorRef } = useFlipMenu(open, 360);
  const canChangeResolution = Boolean(effectiveSourceUrl(video));
  const canNormalize = Boolean(effectiveSourceUrl(video) && onNormalizeVolume);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open, anchorRef]);

  const downloadFile = () => {
    const a = document.createElement("a");
    a.href = downloadFileUrl(video.id);
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setOpen(false);
  };

  const refreshTags = async () => {
    setOpen(false);
    try {
      const updated = await api.refreshVideoTags(video.id);
      onVideoUpdated?.(updated);
      showToast("Tag refresh queued");
    } catch {
      showToast("Could not refresh tags");
    }
  };

  const itemClass =
    "block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-ink-700";

  return (
    <div ref={anchorRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        •••
      </button>
      {/* align left = panel extends to the right of the trigger */}
      <FlipMenuPanel open={open} flip={flip} align="left" className="w-52">
        <button
          onClick={() => {
            onEdit();
            setOpen(false);
          }}
          className={itemClass}
        >
          Edit details
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
        <button
          onClick={() => {
            update({ autoplayRelated: !settings.autoplayRelated });
            setOpen(false);
          }}
          className={itemClass}
        >
          Autoplay related {settings.autoplayRelated ? "✓" : ""}
        </button>
        <button onClick={refreshTags} className={itemClass}>
          Refresh tags (AI)
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
        {canNormalize && (
          <button
            onClick={() => {
              onNormalizeVolume?.();
              setOpen(false);
            }}
            className={itemClass}
          >
            Normalize volume
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
      </FlipMenuPanel>
    </div>
  );
}
