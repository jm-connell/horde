import { backdropClick } from "../utils";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { button } from "./buttons";
import { DIALOG_BACKDROP_ENTER, DIALOG_PANEL_ENTER } from "./dialogMotion";

export type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export default function ConfirmDialog({
  title,
  body,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  busyLabel,
  onCancel,
  onConfirm,
}: ConfirmOptions & {
  children?: ReactNode;
  busy?: boolean;
  busyLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCancelRef = useRef(onCancel);
  const busyRef = useRef(busy);
  onCancelRef.current = onCancel;
  busyRef.current = busy;

  useFocusTrap(panelRef, {
    onEscape: () => {
      if (!busyRef.current) onCancelRef.current();
    },
  });

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const hasBody = body != null;
  const confirmText = busy ? (busyLabel ?? confirmLabel) : confirmLabel;

  return createPortal(
    <div
      className={`fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4 ${DIALOG_BACKDROP_ENTER}`}
      role="presentation"
      onClick={backdropClick(() => {
        if (!busy) onCancel();
      })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasBody ? bodyId : undefined}
        tabIndex={-1}
        className={`ui-panel ui-panel-legible max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-ink-900 p-5 shadow-xl outline-hidden ring-1 ring-ink-600 ${DIALOG_PANEL_ENTER}`}
      >
        <h2 id={titleId} className="text-base font-semibold text-gray-100">
          {title}
        </h2>
        {hasBody ? (
          <div id={bodyId} className="mt-2 text-sm text-gray-300">
            {typeof body === "string" ? (
              <p className="wrap-break-word whitespace-pre-wrap">{body}</p>
            ) : (
              body
            )}
          </div>
        ) : null}
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={button("secondary")}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={button(danger ? "dangerSolid" : "primary")}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
