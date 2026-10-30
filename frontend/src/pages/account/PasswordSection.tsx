import { useState } from "react";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { deviceAccounts } from "../../offline/accounts";
import { PANEL_BTN } from "../settings/constants";

/** Change your own password. Your other browsers are signed out. */
export default function PasswordSection() {
  const { showToast } = useToast();
  const { user } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      // Downloads kept private unlock with the password: use the new one.
      if (user && !user.share_downloads)
        await deviceAccounts.record(user, next);
      showToast("Password changed. Your other browsers were signed out.");
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change it.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="password-heading" data-setting="password">
      <h2
        id="password-heading"
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
      >
        Change password
      </h2>
      <form onSubmit={submit} className="max-w-sm">
        <Field
          label="Current password"
          type="password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <Field
          label="New password"
          type="password"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          hint="Your other browsers are signed out."
          strength
        />
        <Field
          label="Repeat new password"
          type="password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        <FormError message={error} />
        <button type="submit" disabled={busy} className={PANEL_BTN}>
          {busy ? "Saving…" : "Change password"}
        </button>
      </form>
    </section>
  );
}
