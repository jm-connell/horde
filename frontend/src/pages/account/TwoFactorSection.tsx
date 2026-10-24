import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import RecoveryCodes from "../../components/auth/RecoveryCodes";
import TwoFactorEnroll from "../../components/auth/TwoFactorEnroll";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import type { TwoFactorStatus } from "../../types";
import { formatDate } from "../../utils";
import { PANEL_BTN } from "../settings/constants";

type Mode = "idle" | "enroll" | "disable" | "codes" | "showCodes";

/** Turn two-step sign-in on or off, and manage its recovery codes. */
export default function TwoFactorSection() {
  const { user, refresh } = useAuth();
  const { showToast } = useToast();
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [shownCodes, setShownCodes] = useState<string[]>([]);

  const reload = useCallback(async () => {
    try {
      setStatus(await api.getTwoFactor());
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load this setting."
      );
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const finished = async () => {
    setMode("idle");
    await Promise.all([reload(), refresh()]);
  };

  return (
    <section aria-labelledby="two-factor-heading" data-horde="two-factor">
      <h2
        id="two-factor-heading"
        className="mb-1 text-lg font-semibold text-gray-100"
      >
        Two-step sign-in
      </h2>
      <p className="mb-3 text-sm text-muted">
        Ask for a code from an authenticator app as well as your password. It
        keeps your account safe if the password leaks.
      </p>
      {loadError ? (
        <p className="text-sm text-muted">{loadError}</p>
      ) : status === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : mode === "enroll" ? (
        <TwoFactorEnroll
          username={user?.username ?? ""}
          onDone={() => void finished()}
          onCancel={() => setMode("idle")}
        />
      ) : mode === "showCodes" ? (
        <div>
          <RecoveryCodes username={user?.username ?? ""} codes={shownCodes} />
          <button
            type="button"
            className={`${PANEL_BTN} mt-4`}
            onClick={() => void finished()}
          >
            Done
          </button>
        </div>
      ) : mode === "disable" || mode === "codes" ? (
        <ProveIt
          kind={mode}
          onCancel={() => setMode("idle")}
          onDisabled={async () => {
            showToast("Two-step sign-in is off.");
            await finished();
          }}
          onCodes={(codes) => {
            setShownCodes(codes);
            setMode("showCodes");
          }}
        />
      ) : status.enabled ? (
        <div className="space-y-3">
          <p className="text-sm text-gray-200">
            <span className="font-medium text-green-400">On</span>
            {status.enabled_at ? ` since ${formatDate(status.enabled_at)}` : ""}
            . {status.recovery_codes_left} of 10 recovery codes left.
          </p>
          {status.recovery_codes_left <= 2 && (
            <p className="text-sm text-amber-400" role="status">
              You are running low on recovery codes. Make new ones.
            </p>
          )}
          {status.required && (
            <p className="text-xs text-muted">
              An administrator requires two-step sign-in. If you turn it off you
              will be asked to set it up again straight away.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={PANEL_BTN}
              onClick={() => setMode("codes")}
            >
              New recovery codes
            </button>
            <button
              type="button"
              className={PANEL_BTN}
              onClick={() => setMode("disable")}
            >
              Turn off
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-gray-200">
            <span className="font-medium text-gray-100">Off.</span>
            {status.required && " An administrator requires it."}
          </p>
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => setMode("enroll")}
          >
            Set up two-step sign-in
          </button>
        </div>
      )}
    </section>
  );
}

/** Turning it off, or replacing the recovery codes: password and a code. */
function ProveIt({
  kind,
  onCancel,
  onDisabled,
  onCodes,
}: {
  kind: "disable" | "codes";
  onCancel: () => void;
  onDisabled: () => Promise<void>;
  onCodes: (codes: string[]) => void;
}) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "disable") {
        await api.disableTwoFactor(password, code.trim());
        await onDisabled();
      } else {
        onCodes(await api.newRecoveryCodes(password, code.trim()));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setCode("");
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="max-w-sm">
      <p className="mb-3 text-sm text-gray-300">
        {kind === "disable"
          ? "Turning it off needs your password and a code."
          : "New codes cancel the old ones. This needs your password and a code."}
      </p>
      <Field
        label="Current password"
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="current-password"
        focusOnMount
      />
      <Field
        label="Code from your app (or a recovery code)"
        value={code}
        onChange={setCode}
        autoComplete="one-time-code"
      />
      <FormError message={error} />
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={PANEL_BTN}>
          {kind === "disable" ? "Turn off two-step sign-in" : "Make new codes"}
        </button>
        <button type="button" className={PANEL_BTN} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
