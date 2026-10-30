import { useId, useRef } from "react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { backdropClick } from "../../utils";
import { DIALOG_BACKDROP_ENTER, DIALOG_PANEL_ENTER } from "../dialogMotion";
import { CloseIcon } from "../icons";
import TakeoutImport from "./TakeoutImport";

/** `TakeoutImport` in a dialog (Settings → Library). */
export default function TakeoutImportDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: onClose });
  const titleId = useId();
  return (
    <div
      className={`fixed inset-0 z-60 flex items-center justify-center bg-black/60 p-4 ${DIALOG_BACKDROP_ENTER}`}
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`max-h-[90dvh] w-full max-w-xl overflow-y-auto outline-hidden rounded-xl bg-ink-900 p-6 shadow-2xl ring-1 ring-ink-700 ${DIALOG_PANEL_ENTER}`}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold text-gray-100">
            Import from Google Takeout
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted hover:text-gray-300"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>
        <TakeoutImport onFinished={onClose} />
      </div>
    </div>
  );
}
