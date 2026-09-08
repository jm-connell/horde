import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    panelRef.current?.focus();
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) {
        e.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
    // Bind once; cancel/busy are read from refs so Escape stays current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasBody = body != null;
  const confirmText = busy ? busyLabel ?? confirmLabel : confirmLabel;

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hasBody ? bodyId : undefined}
        tabIndex={-1}
        className="ui-panel ui-panel-legible max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-ink-900 p-5 shadow-xl outline-none ring-1 ring-ink-600"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id={titleId}
          className="text-base font-semibold text-gray-100"
        >
          {title}
        </h2>
        {hasBody ? (
          <div id={bodyId} className="mt-2 text-sm text-gray-300">
            {typeof body === "string" ? (
              <p className="break-words whitespace-pre-wrap">{body}</p>
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
                : "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft disabled:opacity-50"
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
