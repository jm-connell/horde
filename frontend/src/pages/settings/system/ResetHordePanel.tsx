import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { createPortal } from "react-dom";
import { useSettingsPage } from "../context";
import { PANEL_BTN, INPUT } from "../constants";
import { api } from "../../../api";
import type { HealthStats, StorageStats } from "../../../types";
import { formatSize } from "../../../utils";
import { clearHordeBrowserState } from "../../../setupStorage";
import Collapse from "../../../components/Collapse";
import { button } from "../../../components/buttons";
import {
  DIALOG_BACKDROP_ENTER,
  DIALOG_PANEL_ENTER,
} from "../../../components/dialogMotion";

export default function ResetHordePanel({
  storage,
  health,
}: {
  storage: StorageStats | null;
  health: HealthStats | null;
}) {
  const { showToast } = useSettingsPage();
  const [open, setOpen] = useState(false);
  const [eraseMedia, setEraseMedia] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [resetting, setResetting] = useState(false);
  const videoCount = storage?.video_count ?? health?.library_video_count ?? 0;
  // The server requires this exact phrase (POST /api/setup/reset).
  const expectedPhrase = eraseMedia ? "ERASE MEDIA" : "RESET";
  const canReset = confirmText.trim() === expectedPhrase;
  const resetDialogRef = useRef<HTMLDivElement>(null);
  // Escape is handled below (it must also respect `resetting`).
  useFocusTrap(resetDialogRef, { active: open });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !resetting) {
        setOpen(false);
        setConfirmText("");
      }
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, resetting]);

  const close = () => {
    if (resetting) return;
    setOpen(false);
    setConfirmText("");
  };

  const runReset = async () => {
    if (resetting || !canReset) return;
    setResetting(true);
    try {
      await api.resetApp(eraseMedia, confirmText.trim());
      clearHordeBrowserState();
      window.location.assign("/setup");
    } catch (err) {
      setResetting(false);
      showToast(err instanceof Error ? err.message : "Reset failed");
    }
  };

  return (
    <>
      <p className="mb-3 text-xs text-muted">
        Restore factory settings and run the setup wizard again. Media volumes
        and Docker environment variables are not changed unless you erase the
        library.
      </p>
      <button type="button" onClick={() => setOpen(true)} className={PANEL_BTN}>
        Reset Horde…
      </button>
      {open
        ? createPortal(
            <>
              <div
                className={`fixed inset-0 z-80 bg-black/60 ${DIALOG_BACKDROP_ENTER}`}
                onClick={close}
                aria-hidden
              />
              <div className="pointer-events-none fixed inset-0 z-81 flex items-start justify-center p-4 pt-[max(1rem,calc(50dvh-8rem))]">
                <div
                  ref={resetDialogRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="reset-horde-title"
                  className={`ui-panel pointer-events-auto w-full max-w-md overflow-y-auto outline-hidden rounded-xl bg-ink-900 p-5 shadow-xl ring-1 ring-ink-600 max-h-[calc(100dvh-2rem)] ${DIALOG_PANEL_ENTER}`}
                >
                  <h2
                    id="reset-horde-title"
                    className="text-base font-semibold text-gray-100"
                  >
                    Reset Horde?
                  </h2>
                  <p className="mt-2 text-sm text-gray-300">
                    Appearance, download, playback, and AI settings return to
                    defaults. You will go through the setup wizard again.
                  </p>
                  <label className="mt-4 flex items-start gap-3 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={eraseMedia}
                      disabled={resetting}
                      onChange={(e) => {
                        setEraseMedia(e.target.checked);
                        setConfirmText("");
                      }}
                    />
                    <span>
                      Erase all media
                      <span className="mt-0.5 block text-xs text-muted">
                        Permanently delete {videoCount} video
                        {videoCount === 1 ? "" : "s"}
                        {storage?.total_bytes
                          ? ` (${formatSize(storage.total_bytes)})`
                          : ""}{" "}
                        plus playlists and channel catalogs. Files on the
                        downloads volume are removed.
                      </span>
                    </span>
                  </label>
                  <Collapse open={!eraseMedia}>
                    <p className="pt-3 text-xs text-muted">
                      Library files, playlists, and watch progress stay on disk.
                    </p>
                  </Collapse>
                  <div className="pt-4">
                    <p className="text-xs text-muted">
                      Type{" "}
                      <span className="font-mono text-gray-300">
                        {expectedPhrase}
                      </span>{" "}
                      to confirm.
                    </p>
                    <input
                      type="text"
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                      disabled={resetting}
                      autoComplete="off"
                      className={`${INPUT} mt-1`}
                      aria-label={`Type ${expectedPhrase} to confirm`}
                    />
                  </div>
                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={close}
                      disabled={resetting}
                      className={button("secondary")}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void runReset()}
                      disabled={resetting || !canReset}
                      className={button("dangerSolid")}
                    >
                      {resetting ? "Resetting…" : "Reset"}
                    </button>
                  </div>
                </div>
              </div>
            </>,
            document.body
          )
        : null}
    </>
  );
}
