import { PANEL_BTN } from "./constants";
import { Toggle } from "./ui";

/**
 * The switch for the Jellyfin / Kodi / Plex files Horde can write beside the
 * media, and the button that deletes them again. Administrators only.
 */
export default function MediaServerFiles({
  enabled,
  onToggle,
  onRemove,
}: {
  enabled: boolean;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mt-6 border-t border-ink-700 pt-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p
            id="settings-media-server-files"
            className="text-sm font-medium text-gray-200"
          >
            Media-server files
          </p>
          <p className="text-xs text-muted">
            Write .nfo files and thumbnails next to your videos so Jellyfin,
            Kodi or Plex show proper titles, descriptions and artwork.{" "}
            <a
              href="/wiki/guides/media-servers/"
              className="text-accent underline underline-offset-2"
            >
              Setup guide
            </a>
          </p>
        </div>
        <Toggle
          checked={enabled}
          onChange={() => onToggle(!enabled)}
          label="Write media-server files"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button onClick={onRemove} disabled={enabled} className={PANEL_BTN}>
          Remove sidecar files
        </button>
        <span className="text-xs text-muted">
          {enabled
            ? "Turn the setting off first. Turning it off keeps the files."
            : "Deletes the .nfo files and thumbnails Horde wrote. Videos are not touched."}
        </span>
      </div>
    </div>
  );
}
