import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import type { HiddenGroup } from "../offline/accounts";
import { useConnectivity } from "../offline/hooks";
import { AUTH_INPUT } from "./auth/AuthForm";

const BTN =
  "ui-panel ui-interactive rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-200 hover:border-accent";

function UnlockForm({
  group,
  onDone,
}: {
  group: HiddenGroup;
  onDone: () => void;
}) {
  const { unlockOffline } = useAuth();
  const { showToast } = useToast();
  const [password, setPassword] = useState("");
  const [wrong, setWrong] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setWrong(false);
    try {
      if (await unlockOffline(group.owner, password)) {
        showToast(`Using ${group.name}’s account until you’re back online`);
        onDone();
        return;
      }
      setWrong(true);
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-48">
        <label htmlFor={id} className="mb-1 block text-xs text-gray-300">
          {`Password for ${group.name}`}
        </label>
        <input
          id={id}
          type="password"
          autoComplete="off"
          required
          ref={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby={wrong ? `${id}-error` : undefined}
          className={AUTH_INPUT}
        />
      </div>
      <button type="submit" disabled={busy} className={BTN}>
        {busy ? "Checking…" : "Unlock"}
      </button>
      <button type="button" className={BTN} onClick={onDone}>
        Cancel
      </button>
      {wrong && (
        <p
          id={`${id}-error`}
          role="alert"
          className="basis-full text-xs text-red-400"
        >
          That password doesn’t match.
        </p>
      )}
    </form>
  );
}

function Notice({ group }: { group: HiddenGroup }) {
  const { signOut } = useAuth();
  const offline = useConnectivity().status === "offline";
  const [unlocking, setUnlocking] = useState(false);
  const videos = `${group.count} video${group.count === 1 ? "" : "s"}`;
  const subject = `${videos} saved by ${group.name} on this device ${group.count === 1 ? "is" : "are"} private.`;
  const canUnlock = offline && group.unlockable;
  const action = !offline
    ? `Switch to ${group.name} to watch ${group.count === 1 ? "it" : "them"}.`
    : canUnlock
      ? `Unlock ${group.name} to watch ${group.count === 1 ? "it" : "them"}.`
      : `Sign in as ${group.name} when you’re back online to watch ${group.count === 1 ? "it" : "them"}.`;

  return (
    <div
      data-horde="private-downloads-notice"
      className="ui-panel mb-4 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-gray-200">
          {subject} {action}
        </p>
        {!offline && (
          <button
            type="button"
            className={BTN}
            onClick={() =>
              void signOut(`/login?username=${encodeURIComponent(group.name)}`)
            }
          >
            Switch account
          </button>
        )}
        {canUnlock && !unlocking && (
          <button
            type="button"
            className={BTN}
            onClick={() => setUnlocking(true)}
          >
            Unlock
          </button>
        )}
      </div>
      {canUnlock && unlocking && (
        <UnlockForm group={group} onDone={() => setUnlocking(false)} />
      )}
    </div>
  );
}

/**
 * Saved videos of other accounts that keep their downloads private: how many
 * there are, and how to get at them (switch account online, unlock offline).
 */
export default function PrivateDownloadsNotice({
  groups,
}: {
  groups: readonly HiddenGroup[];
}) {
  return (
    <>
      {groups.map((g) => (
        <Notice key={g.owner} group={g} />
      ))}
    </>
  );
}
