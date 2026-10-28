import { useEffect, useState, useSyncExternalStore } from "react";
import { api, ApiError } from "../api";
import { useToast } from "../context/ToastContext";
import { deviceAccounts } from "../offline/accounts";
import ConfirmDialog from "./ConfirmDialog";
import { Field } from "./auth/AuthForm";

function SetupDialog({ userId }: { userId: number }) {
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Signed out or switched account meanwhile: the password asked for is not
  // the one the session would check.
  useEffect(() => {
    const check = () => {
      if (deviceAccounts.getViewer()?.id !== userId)
        deviceAccounts.dismissSetup();
    };
    check();
    return deviceAccounts.subscribe(check);
  }, [userId]);

  const submit = async () => {
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyPassword(password);
      await deviceAccounts.setVerifier(userId, password);
      deviceAccounts.dismissSetup();
      showToast("You can open your private downloads offline");
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "wrong_password"
          ? "That isn’t your password."
          : err instanceof Error
            ? err.message
            : "Could not check the password."
      );
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ConfirmDialog
      title="Open your private downloads offline"
      body="So you can open your private downloads offline, confirm your password. This device keeps a check value made from it, not the password, until your last download here is removed."
      confirmLabel="Confirm"
      cancelLabel="Not now"
      busy={busy}
      busyLabel="Checking…"
      onCancel={() => deviceAccounts.dismissSetup()}
      onConfirm={() => void submit()}
    >
      <form
        className="mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="Your password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          focusOnMount
        />
        {error ? (
          <p role="alert" className="-mt-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </ConfirmDialog>
  );
}

/**
 * Asks, once, for the password of an account that keeps its downloads private
 * and has just saved its first one on this device (see `offline/accounts`).
 * Cancelling still keeps the download; the Offline page offers to set it up.
 */
export default function OfflineUnlockSetup() {
  const userId = useSyncExternalStore(
    deviceAccounts.subscribe,
    deviceAccounts.getSetupRequest
  );
  return userId === null ? null : <SetupDialog key={userId} userId={userId} />;
}
