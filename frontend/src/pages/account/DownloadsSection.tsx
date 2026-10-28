import { useState } from "react";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import ShareDownloadsField from "../../components/auth/ShareDownloadsField";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { deviceAccounts } from "../../offline/accounts";
import { PANEL_BTN } from "../settings/constants";

/**
 * Whether other accounts on a device may see the videos you save there. Stopping
 * asks for your password: if this device already holds your downloads it keeps a
 * check value made from it, so you can still unlock them with no connection
 * (otherwise it asks when you save the first one).
 */
export default function DownloadsSection() {
  const { user, refresh } = useAuth();
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  const sharing = user.share_downloads;

  const save = async (share: boolean, current?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.setShareDownloads(share, current);
      // Sharing again needs no check value; stopping makes one from the password
      // when downloads of yours are already on this device.
      await deviceAccounts.record(updated, current);
      await refresh();
      setAsking(false);
      setPassword("");
      showToast(
        share
          ? "Other accounts can see your downloads on shared devices"
          : "Your downloads are private on shared devices"
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save this setting."
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="downloads-heading">
      <h2
        id="downloads-heading"
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
      >
        Downloads on shared devices
      </h2>
      <div className="max-w-md">
        <ShareDownloadsField
          own
          checked={sharing && !asking}
          disabled={busy}
          onChange={(checked) => {
            setError(null);
            if (checked) {
              setAsking(false);
              if (!sharing) void save(true);
            } else {
              setAsking(true);
            }
          }}
        />
        {asking && sharing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save(false, password);
            }}
          >
            <Field
              label="Your password"
              type="password"
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              focusOnMount
              hint="Needed so this device can unlock your downloads when there is no connection."
            />
            <FormError message={error} />
            <div className="flex flex-wrap gap-2">
              <button type="submit" disabled={busy} className={PANEL_BTN}>
                {busy ? "Saving…" : "Keep my downloads private"}
              </button>
              <button
                type="button"
                disabled={busy}
                className={PANEL_BTN}
                onClick={() => {
                  setAsking(false);
                  setPassword("");
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
        {!asking && <FormError message={error} />}
        <p className="mt-3 text-xs text-muted">
          This keeps the people who share a device out of each other’s saved
          videos. It does not encrypt them: anyone with full access to the
          browser can still read the files.
        </p>
      </div>
    </section>
  );
}
