import { backdropClick } from "../utils";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";

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
      className="fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4"
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
        className="ui-panel ui-panel-legible max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-ink-900 p-5 shadow-xl outline-hidden ring-1 ring-ink-600"
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
            className="rounded-lg bg-ink-800 px-4 py-2 text-sm text-gray-300 hover:bg-ink-700 disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={
              danger
                ? "rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-400 disabled:opacity-50"
                : "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-soft disabled:opacity-50"
            }
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
