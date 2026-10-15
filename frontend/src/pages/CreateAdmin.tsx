import { useState } from "react";
import { api } from "../api";
import {
  AuthCard,
  AUTH_PRIMARY,
  Field,
  FormError,
} from "../components/auth/AuthForm";
import { clearLocalSettings } from "../hooks/useSettings";

const MIN_LENGTH = 8;

/**
 * First visit: nobody can sign in yet, so the visitor creates the administrator.
 * On a brand-new install this is step 1 of the setup wizard; on an install that
 * predates accounts it stands alone and the existing watch history moves here.
 */
export default function CreateAdminPage({
  wizard,
  onCreated,
}: {
  wizard: boolean;
  onCreated: () => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters for the password.`);
      return;
    }
    if (password !== repeat) {
      setError("The two passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.bootstrapAdmin(username.trim(), password);
      clearLocalSettings();
      await onCreated();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Could not create the account."
      );
    }
  };

  return (
    <AuthCard
      title="Create the admin account"
      eyebrow={wizard ? "Setup · Step 1" : undefined}
    >
      <p className="mb-5 text-sm text-gray-400">
        {wizard
          ? "Horde asks everyone to sign in. Start with your own administrator account; you can add other people afterwards."
          : "Horde now asks everyone to sign in. Create the administrator account to continue. Your existing watch history will be kept under it."}
      </p>
      <form onSubmit={submit}>
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          focusOnMount
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={`At least ${MIN_LENGTH} characters.`}
        />
        <Field
          label="Repeat password"
          type="password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        <FormError message={error} />
        <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </AuthCard>
  );
}
