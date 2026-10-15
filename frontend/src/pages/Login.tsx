import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import {
  AuthCard,
  AUTH_PRIMARY,
  Field,
  FormError,
} from "../components/auth/AuthForm";
import { safeNextPath } from "../utils/authPaths";
import { clearLocalSettings } from "../hooks/useSettings";

export default function LoginPage() {
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(username.trim(), password);
      // A full load starts the app from a clean slate for this user.
      clearLocalSettings();
      window.location.assign(safeNextPath(params.get("next")));
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.code === "rate_limited") {
        setError(err.message);
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Wrong username or password.");
      } else {
        setError(
          err instanceof Error ? err.message : "Could not sign in. Try again."
        );
      }
      setPassword("");
    }
  };

  return (
    <AuthCard title="Sign in to Horde">
      <form onSubmit={submit} noValidate={false}>
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
          autoComplete="current-password"
        />
        <FormError message={error} />
        <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}
