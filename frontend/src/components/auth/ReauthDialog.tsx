import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../../api";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { backdropClick } from "../../utils";
import { Field, FormError } from "./AuthForm";
import { button } from "../buttons";

/**
 * "Confirm your password": the step-up before a sensitive administrator action
 * (a new account, another account's password, ...). Asks for a code as well
 * when the account signs in with two-step sign-in.
 */
export default function ReauthDialog({
  needsCode,
  onDone,
}: {
  needsCode: boolean;
  /** `true` once the server accepted the password; `false` if the user gave up. */
  onDone: (confirmed: boolean) => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useFocusTrap(panelRef, {
    onEscape: () => {
      if (!busyRef.current) onDoneRef.current(false);
    },
  });

  // After the focus trap has taken focus into the panel: start in the password field.
  useEffect(() => {
    panelRef.current?.querySelector("input")?.focus();
  }, []);

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.reauthenticate(password, code.trim());
      onDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setCode("");
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-90 flex items-center justify-center bg-black/60 p-4"
      role="presentation"
      onClick={backdropClick(() => {
        if (!busy) onDone(false);
      })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        data-horde="reauth-dialog"
        className="ui-panel ui-panel-legible max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-ink-900 p-5 shadow-xl outline-hidden ring-1 ring-ink-600"
      >
        <h2 id={titleId} className="text-base font-semibold text-gray-100">
          Confirm your password
        </h2>
        <form onSubmit={submit} className="mt-2">
          <p id={bodyId} className="mb-4 text-sm text-gray-300">
            This action needs your password again
            {needsCode ? " and a code from your authenticator app" : ""}, in
            case someone else is using this browser.
          </p>
          <Field
            label="Your password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          {needsCode && (
            <Field
              label="Code from your app (or a recovery code)"
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
            />
          )}
          <FormError message={error} />
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => onDone(false)}
              disabled={busy}
              className={button("secondary")}
            >
              Cancel
            </button>
            <button type="submit" disabled={busy} className={button("primary")}>
              {busy ? "Checking…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
