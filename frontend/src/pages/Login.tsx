import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import {
  AuthCard,
  AUTH_PRIMARY,
  Field,
  FormError,
} from "../components/auth/AuthForm";
import ForgotPassword from "../components/auth/ForgotPassword";
import { safeNextPath } from "../utils/authPaths";
import { clearLocalSettings } from "../hooks/useSettings";
import { deviceAccounts } from "../offline/accounts";

export default function LoginPage() {
  const [params] = useSearchParams();
  // "Switch account" links here with the name filled in.
  const [username, setUsername] = useState(params.get("username") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);

  const enterApp = () => {
    // A full load starts the app from a clean slate for this user.
    clearLocalSettings();
    window.location.assign(safeNextPath(params.get("next")));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username.trim(), password);
      // The one moment the password is at hand: keep a way to unlock this
      // account's private downloads on this device with no connection.
      await deviceAccounts.record(user, password);
      enterApp();
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

  if (forgot) {
    return (
      <AuthCard title="Reset your password">
        <ForgotPassword
          initialUsername={username}
          onBack={() => setForgot(false)}
          onSignedIn={async (user, newPassword) => {
            await deviceAccounts.record(user, newPassword);
            enterApp();
          }}
        />
      </AuthCard>
    );
  }

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
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setForgot(true);
            }}
            className="text-sm text-gray-400 underline-offset-2 hover:text-accent hover:underline"
          >
            Forgot password?
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
