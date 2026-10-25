import { useState } from "react";
import { api, ApiError } from "../../api";
import type { AuthUser } from "../../types";
import { AUTH_PRIMARY, Field, FormError } from "./AuthForm";

const LINK =
  "text-sm text-gray-400 underline-offset-2 hover:text-accent hover:underline";

/**
 * "Forgot password?": the server writes a one-time code to its log, which
 * whoever runs Horde reads (`docker logs horde`); the code and a new password
 * reset the account and sign in.
 */
export default function ForgotPassword({
  initialUsername,
  onBack,
  onSignedIn,
  onSecondStep,
}: {
  initialUsername: string;
  onBack: () => void;
  /** Signed in with the new password. */
  onSignedIn: (user: AuthUser, password: string) => void | Promise<void>;
  /**
   * The password was reset, but the account has two-step sign-in: the sign-in
   * continues with the code step, using this ticket.
   */
  onSecondStep: (pendingToken: string, password: string) => void;
}) {
  const [step, setStep] = useState<"ask" | "reset">("ask");
  const [username, setUsername] = useState(initialUsername);
  const [code, setCode] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const describe = (err: unknown) =>
    err instanceof ApiError || err instanceof Error
      ? err.message
      : "Something went wrong. Try again.";

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !username.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(username.trim());
      setStep("reset");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (next !== repeat) {
      setError("The two new passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.resetPassword(username.trim(), code, next);
      await onSignedIn(user, next);
    } catch (err) {
      const pendingToken =
        err instanceof ApiError ? err.extra?.pending_token : null;
      if (
        err instanceof ApiError &&
        err.code === "totp_required" &&
        typeof pendingToken === "string"
      ) {
        onSecondStep(pendingToken, next);
        return;
      }
      setBusy(false);
      setError(describe(err));
    }
  };

  if (step === "ask") {
    return (
      <form onSubmit={ask}>
        <p className="mb-4 text-sm text-gray-400">
          Horde writes a one-time reset code to the server log. Whoever runs
          this server can read it there and give it to you.
        </p>
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="username"
          focusOnMount
        />
        <FormError message={error} />
        <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
          {busy ? "Asking…" : "Get a reset code"}
        </button>
        <div className="mt-4 text-center">
          <button type="button" className={LINK} onClick={onBack}>
            Back to sign in
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={reset}>
      {/* Lets a password manager save the new password for this account. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={username.trim()}
        readOnly
        hidden
      />
      <div
        role="status"
        className="mb-4 rounded-lg border border-ink-700 bg-ink-950/60 p-3 text-sm text-gray-300"
      >
        <p>
          If{" "}
          <span className="font-medium text-gray-100">{username.trim()}</span>{" "}
          has an account, a reset code for it is in the server log: use the
          newest <span className="font-mono text-xs">PASSWORD RESET CODE</span>{" "}
          line, for example from{" "}
          <code className="font-mono text-xs text-accent">
            docker logs horde
          </code>{" "}
          on the server (with <code className="font-mono text-xs">sudo</code> in
          front on most hosts) or the stack&apos;s log in Dockge.
        </p>
        <p className="mt-2 text-xs text-muted">
          A code works once and expires after 15 minutes. A new code can be
          written every 30 seconds; the last three stay valid.
        </p>
      </div>
      <Field
        label="Reset code"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
        focusOnMount
      />
      <Field
        label="New password"
        type="password"
        value={next}
        onChange={setNext}
        autoComplete="new-password"
        hint="At least 8 characters. Every other browser is signed out."
      />
      <Field
        label="Repeat new password"
        type="password"
        value={repeat}
        onChange={setRepeat}
        autoComplete="new-password"
      />
      <FormError message={error} />
      <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
        {busy ? "Saving…" : "Reset password and sign in"}
      </button>
      <div className="mt-4 flex justify-between gap-2">
        <button
          type="button"
          className={LINK}
          onClick={() => {
            setError(null);
            setStep("ask");
          }}
        >
          Ask for another code
        </button>
        <button type="button" className={LINK} onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
