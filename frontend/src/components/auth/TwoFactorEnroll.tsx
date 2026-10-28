import { useState } from "react";
import { api } from "../../api";
import { PANEL_BTN } from "../../pages/settings/constants";
import type { TwoFactorSetup } from "../../types";
import { AUTH_PRIMARY, Field, FormError } from "./AuthForm";
import RecoveryCodes from "./RecoveryCodes";

/** An SVG string as an image source (an <img> never runs anything inside it). */
function svgSource(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Setting up two-step sign-in, start to finish: password, scan or type the key,
 * a first code, then the recovery codes. Used in Account settings and on the
 * screen an account sees when an administrator requires it.
 */
export default function TwoFactorEnroll({
  username,
  onDone,
  onCancel,
}: {
  username: string;
  /** The recovery codes were shown and the person is finished. */
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const describe = (err: unknown) =>
    err instanceof Error ? err.message : "Something went wrong. Try again.";

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.startTwoFactor(password));
      setPassword("");
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setCodes(await api.confirmTwoFactor(code));
      setSetup(null);
      setCode("");
    } catch (err) {
      setError(describe(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div>
        <p className="mb-3 text-sm font-medium text-emerald-400" role="status">
          Two-step sign-in is on.
        </p>
        <RecoveryCodes username={username} codes={codes} />
        <button
          type="button"
          className={`${AUTH_PRIMARY} mt-4`}
          onClick={onDone}
        >
          I have saved these codes
        </button>
      </div>
    );
  }

  if (setup) {
    return (
      <form onSubmit={confirm} className="max-w-sm">
        <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm text-gray-300">
          <li>
            Scan this with an authenticator app (1Password, Aegis, Google
            Authenticator, Authy…).
          </li>
          <li>Enter the 6-digit code it shows.</li>
        </ol>
        <img
          src={svgSource(setup.qr_svg)}
          alt="QR code for your authenticator app"
          width={180}
          height={180}
          className="mb-3 rounded-lg bg-white p-2"
        />
        <p className="mb-4 text-xs text-muted">
          Can’t scan? Type this key into the app instead:{" "}
          <code
            data-horde="totp-secret"
            className="select-all rounded-sm bg-ink-950 px-1.5 py-0.5 font-mono text-gray-100"
          >
            {setup.secret}
          </code>
        </p>
        <Field
          label="6-digit code"
          value={code}
          onChange={setCode}
          autoComplete="one-time-code"
          inputMode="numeric"
          focusOnMount
        />
        <FormError message={error} />
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className={AUTH_PRIMARY}>
            {busy ? "Checking…" : "Turn on two-step sign-in"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={start} className="max-w-sm">
      <p className="mb-4 text-sm text-gray-300">
        Signing in will also ask for a code from an authenticator app on your
        phone. Enter your password to begin.
      </p>
      <Field
        label="Current password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        focusOnMount
      />
      <FormError message={error} />
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy} className={PANEL_BTN}>
          {busy ? "Starting…" : "Continue"}
        </button>
        {onCancel && (
          <button type="button" className={PANEL_BTN} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
