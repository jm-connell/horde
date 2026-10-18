import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useToast } from "../../context/ToastContext";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { backdropClick } from "../../utils";
import { AUTH_PRIMARY, Field, FormError } from "./AuthForm";

export default function ChangePasswordModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useFocusTrap(panelRef, { onEscape: onClose });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next !== repeat) {
      setError("The two new passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      showToast("Password changed. Your other browsers were signed out.");
      onClose();
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Could not change it.");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-80 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={backdropClick(onClose)}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-panel ui-panel-legible w-full max-w-sm rounded-xl bg-ink-900 p-5 shadow-xl outline-hidden ring-1 ring-ink-600"
      >
        <h2 id={titleId} className="mb-4 text-base font-semibold text-gray-100">
          Change password
        </h2>
        <form onSubmit={submit}>
          <Field
            label="Current password"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            focusOnMount
          />
          <Field
            label="New password"
            type="password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
            hint="At least 8 characters."
          />
          <Field
            label="Repeat new password"
            type="password"
            value={repeat}
            onChange={setRepeat}
            autoComplete="new-password"
          />
          <FormError message={error} />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className={`${AUTH_PRIMARY} w-auto!`}
            >
              {busy ? "Saving…" : "Change password"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
