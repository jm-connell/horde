import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import type { DeviceSession } from "../../types";
import { PANEL_BTN } from "../settings/constants";
import SessionRows from "./SessionRows";

/** Where you are signed in, with a way to end any of those sessions. */
export default function DevicesSection() {
  const { signOut } = useAuth();
  const { showToast, showError } = useToast();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setSessions(await api.listSessions());
    } catch (err) {
      showError(
        `Could not load your devices: ${err instanceof Error ? err.message : "error"}`
      );
    }
  }, [showError]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      showToast(done);
      await reload();
    } catch (err) {
      showError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const signOutDevice = async (s: DeviceSession) => {
    if (s.current) {
      const ok = await confirm({
        title: "Sign out of this device?",
        body: "You will need to sign in again to keep using Horde here.",
        confirmLabel: "Sign out",
      });
      if (ok) await signOut();
      return;
    }
    await run(() => api.revokeSession(s.id), `Signed out ${s.device}`);
  };

  const others = (sessions ?? []).filter((s) => !s.current);

  return (
    <section aria-labelledby="devices-heading">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h2
          id="devices-heading"
          className="text-lg font-semibold text-gray-100"
        >
          Signed-in devices
        </h2>
        {others.length > 0 && (
          <button
            type="button"
            className={`${PANEL_BTN} ml-auto`}
            disabled={busy}
            onClick={() =>
              void run(
                () => api.revokeOtherSessions(),
                "Signed out your other devices"
              )
            }
          >
            Sign out all other devices
          </button>
        )}
      </div>
      <p className="mb-3 text-sm text-muted">
        Browsers where your account is signed in. Sign out any you don&apos;t
        recognise.
      </p>
      {sessions === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <SessionRows
          sessions={sessions}
          busy={busy}
          onSignOut={(s) => void signOutDevice(s)}
        />
      )}
    </section>
  );
}
