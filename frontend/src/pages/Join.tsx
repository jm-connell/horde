import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../api";
import {
  AuthCard,
  AUTH_PRIMARY,
  Field,
  FormError,
} from "../components/auth/AuthForm";
import { clearLocalSettings } from "../hooks/useSettings";
import { deviceAccounts } from "../offline/accounts";
import type { InviteInfo } from "../types";

/**
 * `/join?token=...`: someone opened an invite link. They pick their own
 * username and password and are signed in as a member.
 */
export default function JoinPage({
  onJoined,
}: {
  onJoined: () => Promise<void>;
}) {
  const location = useLocation();
  const token = new URLSearchParams(location.search).get("token") ?? "";
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      setInvalid("This link has no invite in it. Ask for a new one.");
      return;
    }
    let active = true;
    api
      .checkInvite(token)
      .then((info) => {
        if (active) setInvite(info);
      })
      .catch((err) => {
        if (active)
          setInvalid(
            err instanceof Error
              ? err.message
              : "This invite link is not valid."
          );
      });
    return () => {
      active = false;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password !== repeat) {
      setError("The two passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.acceptInvite(token, username.trim(), password);
      await deviceAccounts.record(user, password);
      clearLocalSettings();
      // Leave /join for the library once the new session is in place.
      window.history.replaceState(null, "", "/");
      await onJoined();
    } catch (err) {
      setBusy(false);
      setError(
        err instanceof Error ? err.message : "Could not create the account."
      );
    }
  };

  if (invalid) {
    return (
      <AuthCard title="This invite doesn’t work">
        <p className="text-sm text-gray-400">{invalid}</p>
        <p className="mt-3 text-sm text-gray-400">
          Invite links work once and expire. Ask whoever sent it for a new one,
          or{" "}
          <a href="/login" className="text-accent hover:underline">
            sign in
          </a>{" "}
          if you already have an account.
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Join Horde"
      eyebrow={invite?.label ? `For ${invite.label}` : undefined}
    >
      <p className="mb-5 text-sm text-gray-400">
        You’ve been invited to this Horde server. Pick a username and password;
        your watch history and look stay your own.
      </p>
      <form onSubmit={submit}>
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
          autoComplete="new-password"
          strength
        />
        <Field
          label="Repeat password"
          type="password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        <FormError message={error} />
        <button
          type="submit"
          disabled={busy || !invite}
          className={AUTH_PRIMARY}
        >
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </AuthCard>
  );
}
