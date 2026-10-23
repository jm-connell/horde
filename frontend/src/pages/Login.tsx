import { useRef, useState } from "react";
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
import { looksLikeRecoveryCode } from "../utils/twoFactor";
import type { AuthUser } from "../types";

const LINK =
  "text-sm text-gray-400 underline-offset-2 hover:text-accent hover:underline";

/** The ticket of a sign-in that is waiting for its second step, if `err` is one. */
function ticketOf(err: unknown): string | null {
  if (!(err instanceof ApiError) || err.code !== "totp_required") return null;
  const token = err.extra?.pending_token;
  return typeof token === "string" ? token : null;
}

export default function LoginPage() {
  const [params] = useSearchParams();
  // "Switch account" links here with the name filled in.
  const [username, setUsername] = useState(params.get("username") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  // The second step of a two-step sign-in. The password waits in a ref (not
  // state, never rendered) until the code is accepted: only then is the sign-in
  // real, and only then may this device keep a check value of the password.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const pendingPassword = useRef("");

  const enterApp = () => {
    // A full load starts the app from a clean slate for this user.
    clearLocalSettings();
    window.location.assign(safeNextPath(params.get("next")));
  };

  const startSecondStep = (pendingToken: string, forPassword: string) => {
    pendingPassword.current = forPassword;
    setTicket(pendingToken);
    setCode("");
    setRecovery(false);
    setPassword("");
    setError(null);
    setBusy(false);
  };

  const backToPassword = (message: string | null) => {
    pendingPassword.current = "";
    setTicket(null);
    setCode("");
    setPassword("");
    setError(message);
    setBusy(false);
  };

  const signedIn = async (user: AuthUser, forPassword: string) => {
    // The one moment the password is at hand: if this device already holds
    // this account's private downloads, keep a way to unlock them with no
    // connection.
    await deviceAccounts.record(user, forPassword);
    pendingPassword.current = "";
    enterApp();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username.trim(), password);
      await signedIn(user, password);
    } catch (err) {
      const pendingToken = ticketOf(err);
      if (pendingToken) {
        startSecondStep(pendingToken, password);
        return;
      }
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

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !ticket) return;
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.loginTotp(ticket, code.trim());
      await signedIn(user, pendingPassword.current);
    } catch (err) {
      if (err instanceof ApiError && err.code === "totp_ticket_invalid") {
        backToPassword("That sign-in expired. Enter your password again.");
        return;
      }
      setBusy(false);
      setCode("");
      if (err instanceof ApiError && err.code === "rate_limited") {
        setError(err.message);
      } else if (err instanceof ApiError && err.code === "invalid_totp") {
        setError(
          recovery || looksLikeRecoveryCode(code)
            ? "That recovery code is wrong or was already used."
            : "That code didn’t work. Check the time on your phone and try the next one."
        );
      } else {
        setError(
          err instanceof Error ? err.message : "Could not sign in. Try again."
        );
      }
    }
  };

  if (forgot) {
    return (
      <AuthCard title="Reset your password">
        <ForgotPassword
          initialUsername={username}
          onBack={() => setForgot(false)}
          onSignedIn={async (user, newPassword) => {
            await signedIn(user, newPassword);
          }}
          onSecondStep={(pendingToken, newPassword) => {
            setForgot(false);
            startSecondStep(pendingToken, newPassword);
          }}
        />
      </AuthCard>
    );
  }

  if (ticket) {
    return (
      <AuthCard title="Two-step sign-in">
        <form onSubmit={submitCode}>
          <p className="mb-4 text-sm text-gray-400">
            {recovery
              ? "Enter one of your recovery codes. Each works once."
              : "Enter the 6-digit code from your authenticator app."}
          </p>
          <Field
            key={recovery ? "recovery" : "code"}
            label={recovery ? "Recovery code" : "6-digit code"}
            value={code}
            onChange={setCode}
            autoComplete={recovery ? "off" : "one-time-code"}
            inputMode={recovery ? "text" : "numeric"}
            focusOnMount
          />
          <FormError message={error} />
          <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
            {busy ? "Checking…" : "Verify"}
          </button>
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setRecovery((v) => !v);
                setCode("");
                setError(null);
              }}
              className={LINK}
            >
              {recovery ? "Use the app’s code" : "Use a recovery code"}
            </button>
            <button
              type="button"
              onClick={() => backToPassword(null)}
              className={LINK}
            >
              Back
            </button>
          </div>
        </form>
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
            className={LINK}
          >
            Forgot password?
          </button>
        </div>
      </form>
    </AuthCard>
  );
}
