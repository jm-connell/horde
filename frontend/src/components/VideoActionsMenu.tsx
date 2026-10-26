import { useEffect, useRef, useState } from "react";
import { api, downloadFileUrl } from "../api";
import { useAuth } from "../context/AuthContext";
import { useSettings } from "../hooks/useSettings";
import { useToast } from "../context/ToastContext";
import { FlipMenuPanel, useFlipMenu } from "../hooks/useFlipMenu";
import { extractYouTubeId } from "../hooks/useSponsorBlock";
import { MenuScroll } from "./MenuFlyout";
import { useOfflineDownloadAction } from "./OfflineDownloadButton";
import type { Video } from "../types";
import { effectiveSourceUrl, safeHref } from "../utils";

function sourceLinkLabel(video: Video): string {
  const platform = (video.platform || "").toLowerCase();
  if (
    extractYouTubeId(video.source_url, video.file_path) ||
    platform.includes("youtube")
  ) {
    return "Open on YouTube ↗";
  }
  if (platform) {
    const name = platform.replace(/ie$/, "").replace(/_/g, " ");
    const pretty = name.charAt(0).toUpperCase() + name.slice(1);
    return `Open on ${pretty} ↗`;
  }
  return "Source link ↗";
}

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
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const [settings, update] = useSettings();
  const { showToast, showError } = useToast();
  const { flip, anchorRef } = useFlipMenu(open, 360);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const canChangeResolution =
    can("download") && Boolean(effectiveSourceUrl(video));
  const canNormalize =
    can("download") && Boolean(effectiveSourceUrl(video) && onNormalizeVolume);
  const offline = useOfflineDownloadAction(video);
  const offlineLabel =
    offline.status === "complete"
      ? "Remove download"
      : offline.status === "paused"
        ? `Resume download (${offline.label.replace("Paused ", "")})`
        : offline.item && offline.status !== "error"
          ? `Cancel download (${Math.round(offline.progress * 100)}%)`
          : offline.status === "error"
            ? "Retry offline download"
            : "Download for offline";

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-horde='flip-menu']")) return;
      setOpen(false);
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
      showError("Could not refresh tags");
    }
  };

  const itemClass =
    "block w-full px-4 py-2 text-left text-sm text-gray-200 hover:bg-ink-700";

  return (
    <div ref={anchorRef} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        className="ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-gray-200 ring-1 ring-ink-700 hover:bg-ink-700"
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        •••
      </button>
      {/* align left = panel extends to the right of the trigger */}
      <FlipMenuPanel
        open={open}
        flip={flip}
        align="left"
        className="w-52"
        menu={{
          label: "Video actions",
          onClose: () => setOpen(false),
          triggerRef,
        }}
      >
        <MenuScroll className="max-h-[min(24rem,calc(100dvh-2rem))]">
          {can("edit_metadata") && (
            <button
              onClick={() => {
                onEdit();
                setOpen(false);
              }}
              role="menuitem"
              className={itemClass}
            >
              Edit details
            </button>
          )}
          {can("edit_metadata") && (
            <button
              onClick={() => {
                onAddNote();
                setOpen(false);
              }}
              role="menuitem"
              className={itemClass}
            >
              Add note
            </button>
          )}
          <button
            onClick={() => {
              update({ autoplayRelated: !settings.autoplayRelated });
              setOpen(false);
            }}
            role="menuitemcheckbox"
            aria-checked={settings.autoplayRelated}
            className={itemClass}
          >
            Autoplay related {settings.autoplayRelated ? "✓" : ""}
          </button>
          {can("use_ai") && (
            <button onClick={refreshTags} role="menuitem" className={itemClass}>
              Refresh tags (AI)
            </button>
          )}
          {canChangeResolution && (
            <button
              onClick={() => {
                onChangeResolution();
                setOpen(false);
              }}
              role="menuitem"
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
              role="menuitem"
              className={itemClass}
            >
              Normalize volume
            </button>
          )}
          {can("offline_download") && (
            <button
              onClick={() => {
                setOpen(false);
                void offline.onClick();
              }}
              role="menuitem"
              className={itemClass}
            >
              {offlineLabel}
            </button>
          )}
          {can("offline_download") && (
            <button
              onClick={downloadFile}
              role="menuitem"
              className={itemClass}
            >
              Save file to device
            </button>
          )}
          {safeHref(video.source_url) && (
            <a
              href={safeHref(video.source_url)}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
              role="menuitem"
              className={itemClass}
            >
              {sourceLinkLabel(video)}
            </a>
          )}
          {can("delete_videos") && (
            <button
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              role="menuitem"
              className="block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-500/10"
            >
              Delete
            </button>
          )}
        </MenuScroll>
      </FlipMenuPanel>
    </div>
  );
}
