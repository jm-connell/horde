import { useCallback, useEffect, useState } from "react";
import ParentalControls from "./ParentalControls";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import UserAvatar from "../../components/auth/UserAvatar";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import ShareDownloadsField from "../../components/auth/ShareDownloadsField";
import type {
  DeviceSession,
  Invite,
  Permission,
  PermissionInfo,
  UserAccount,
} from "../../types";
import AccountTypeFields from "../settings/AccountTypeFields";
import { PANEL_BTN } from "../settings/constants";
import SessionRows from "./SessionRows";
import { button } from "../../components/buttons";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Administrators: everyone's accounts, and adding new ones. */
export default function UsersSection() {
  const { user: me } = useAuth();
  const { showToast, showError } = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [catalog, setCatalog] = useState<PermissionInfo[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (err) {
      showError(`Could not load users: ${describe(err)}`);
    }
  }, [showError]);

  useEffect(() => {
    api
      .listPermissions()
      .then(setCatalog)
      .catch((err) =>
        showError(`Could not load permissions: ${describe(err)}`)
      );
  }, [showError]);

  // Your own row shows your picture, so changing it above loads the list again.
  const myAvatar = me?.avatar_version;
  useEffect(() => {
    void reload();
  }, [myAvatar, reload]);

  const remove = async (u: UserAccount) => {
    const ok = await confirm({
      title: `Delete ${u.username}?`,
      body: "Their account, watch history, AI chats and saved preferences are removed. Videos and playlists stay.",
      confirmLabel: "Delete user",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deleteUser(u.id);
      showToast(`Deleted ${u.username}`);
      setEditing(null);
      await reload();
    } catch (err) {
      showError(describe(err));
    }
  };

  return (
    <div data-horde="users-section" className="space-y-6">
      <section aria-labelledby="users-heading" data-setting="users">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2
            id="users-heading"
            className="text-xs font-semibold uppercase tracking-wider text-gray-400"
          >
            Users
          </h2>
          <button
            type="button"
            className={`${PANEL_BTN} ml-auto`}
            aria-expanded={adding}
            aria-controls="create-user"
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? "Cancel" : "Add a user"}
          </button>
        </div>
        <p className="mb-4 text-xs text-muted">
          Everyone signs in with their own account and has their own watch
          history. The library and playlists are shared; each account decides
          whether others on the same device see its offline downloads.
        </p>
        {users === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
            {users.map((u) => (
              <li key={u.id} data-horde="user-row" className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <UserAvatar
                    userId={u.id}
                    username={u.username}
                    version={u.avatar_version}
                  />
                  <span className="font-medium text-gray-100">
                    {u.username}
                  </span>
                  {u.id === me?.id && (
                    <span className="text-xs text-muted">(you)</span>
                  )}
                  <span className="rounded-sm bg-ink-800 px-1.5 py-0.5 text-xs text-gray-300">
                    {u.is_admin ? "Admin" : "Member"}
                  </span>
                  {u.two_factor_enabled && (
                    <span
                      className="rounded-sm bg-ink-800 px-1.5 py-0.5 text-xs text-success"
                      title="Signs in with a code from an authenticator app"
                    >
                      Two-step
                    </span>
                  )}
                  {u.disabled && (
                    <span className="rounded-sm bg-danger/10 px-1.5 py-0.5 text-xs text-danger">
                      Disabled
                    </span>
                  )}
                  <button
                    type="button"
                    className={`${PANEL_BTN} ml-auto`}
                    aria-expanded={editing === u.id}
                    onClick={() => setEditing(editing === u.id ? null : u.id)}
                  >
                    {editing === u.id ? "Close" : `Edit ${u.username}`}
                  </button>
                </div>
                {editing === u.id && (
                  <UserEditor
                    key={u.id}
                    user={u}
                    isSelf={u.id === me?.id}
                    catalog={catalog}
                    onChanged={reload}
                    onDelete={() => void remove(u)}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <InviteLinks catalog={catalog} />
      {adding && (
        <CreateUser
          catalog={catalog}
          onCreated={async () => {
            setAdding(false);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function inviteUrl(token: string): string {
  return `${window.location.origin}/join?token=${encodeURIComponent(token)}`;
}

/** One-time links that let someone pick their own username and password. */
function InviteLinks({ catalog }: { catalog: PermissionInfo[] }) {
  const { showToast, showError } = useToast();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [granted, setGranted] = useState<Permission[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const effective = granted ?? defaultsOf(catalog);

  const reload = useCallback(async () => {
    try {
      setInvites(await api.listInvites());
    } catch (err) {
      showError(`Could not load invites: ${describe(err)}`);
    }
  }, [showError]);
  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.createInvite({
        label: label.trim() || null,
        permissions: effective,
      });
      setMade(inviteUrl(res.token));
      setLabel("");
      setGranted(null);
      await reload();
    } catch (err) {
      showError(`Could not make the link: ${describe(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      showToast("Link copied");
    } catch {
      showError("Could not copy; select the link and copy it yourself");
    }
  };

  const revoke = async (invite: Invite) => {
    try {
      await api.revokeInvite(invite.id);
      await reload();
    } catch (err) {
      showError(describe(err));
    }
  };

  return (
    <section
      aria-labelledby="invites-heading"
      data-setting="invites"
      className="rounded-lg border border-ink-700 p-4"
    >
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <h3 id="invites-heading" className="text-sm font-medium text-gray-200">
          Invite links
        </h3>
        <button
          type="button"
          className={`${PANEL_BTN} ml-auto`}
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
            setMade(null);
          }}
        >
          {open ? "Close" : "Make an invite link"}
        </button>
      </div>
      <p className="mb-3 text-xs text-muted">
        Send someone a link instead of a password: they pick their own username
        and password and join as a member. A link works once and expires after 7
        days.
      </p>
      {open && (
        <form onSubmit={create} className="mb-3 max-w-md">
          <Field
            label="Who is it for? (optional)"
            value={label}
            onChange={setLabel}
            autoComplete="off"
            required={false}
            hint="Shown on the page they open, e.g. “Mum”."
          />
          <AccountTypeFields
            isAdmin={false}
            granted={effective}
            catalog={catalog}
            onAdminChange={() => undefined}
            onGrantedChange={setGranted}
            allowAdmin={false}
          />
          <button type="submit" disabled={busy} className={PANEL_BTN}>
            {busy ? "Making…" : "Make link"}
          </button>
        </form>
      )}
      {made && (
        <div className="mb-3 rounded-lg bg-ink-900 p-3 ring-1 ring-ink-700">
          <p className="mb-2 text-xs text-muted">
            Send this link. It is shown only now.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              readOnly
              aria-label="Invite link"
              value={made}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 font-mono text-xs text-gray-100"
            />
            <button
              type="button"
              className={PANEL_BTN}
              onClick={() => void copy(made)}
            >
              Copy
            </button>
          </div>
        </div>
      )}
      {invites && invites.length > 0 && (
        <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700 text-sm">
          {invites.map((invite) => (
            <li
              key={invite.id}
              className="flex flex-wrap items-center gap-2 p-2"
            >
              <span className="text-gray-200">
                {invite.label || "Unnamed invite"}
              </span>
              <span className="text-xs text-muted">
                expires {new Date(invite.expires_at).toLocaleDateString()}
              </span>
              <button
                type="button"
                className={`${button("quiet", "xs")} ml-auto`}
                onClick={() => void revoke(invite)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function defaultsOf(catalog: PermissionInfo[]): Permission[] {
  return catalog.filter((p) => p.default).map((p) => p.name);
}

function CreateUser({
  catalog,
  onCreated,
}: {
  catalog: PermissionInfo[];
  onCreated: () => Promise<void>;
}) {
  const { showToast } = useToast();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [granted, setGranted] = useState<Permission[] | null>(null);
  const [share, setShare] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const effective = granted ?? defaultsOf(catalog);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createUser({
        username: username.trim(),
        password,
        is_admin: isAdmin,
        permissions: isAdmin ? undefined : effective,
        share_downloads: share,
      });
      showToast(`Created ${created.username}`);
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      setGranted(null);
      setShare(true);
      await onCreated();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="create-user"
      aria-labelledby="create-user-heading"
      className="rounded-lg border border-ink-700 p-4"
    >
      <h3
        id="create-user-heading"
        className="mb-3 text-sm font-medium text-gray-200"
      >
        Add a user
      </h3>
      <form onSubmit={submit} className="max-w-md">
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          autoComplete="off"
          focusOnMount
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="Share it with them yourself."
          strength
        />
        <AccountTypeFields
          isAdmin={isAdmin}
          granted={effective}
          catalog={catalog}
          onAdminChange={setIsAdmin}
          onGrantedChange={setGranted}
        />
        <ShareDownloadsField checked={share} onChange={setShare} />
        <FormError message={error} />
        <button type="submit" disabled={busy} className={PANEL_BTN}>
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>
    </section>
  );
}

function UserEditor({
  user,
  isSelf,
  catalog,
  onChanged,
  onDelete,
}: {
  user: UserAccount;
  /** Your own account: the server refuses demoting or disabling yourself. */
  isSelf: boolean;
  catalog: PermissionInfo[];
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const { showToast } = useToast();
  const confirm = useConfirm();
  const [isAdmin, setIsAdmin] = useState(user.is_admin);
  const [granted, setGranted] = useState<Permission[]>(user.permissions);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (
    change: Parameters<typeof api.updateUser>[1],
    done: string
  ) => {
    setBusy(true);
    setError(null);
    try {
      await api.updateUser(user.id, change);
      showToast(done);
      await onChanged();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 space-y-4 rounded-lg bg-ink-950/50 p-3">
      {isSelf ? (
        <p className="text-sm text-muted">
          You can’t remove your own administrator access or disable your own
          account. Another administrator has to do it.
        </p>
      ) : (
        <div>
          <AccountTypeFields
            isAdmin={isAdmin}
            granted={isAdmin ? defaultsOf(catalog) : granted}
            catalog={catalog}
            onAdminChange={(v) => {
              setIsAdmin(v);
              if (!v && user.is_admin) setGranted(defaultsOf(catalog));
            }}
            onGrantedChange={setGranted}
            disabled={busy}
          />
          <button
            type="button"
            className={PANEL_BTN}
            disabled={busy}
            onClick={() =>
              void run(
                isAdmin
                  ? { is_admin: true }
                  : { is_admin: false, permissions: granted },
                `Saved ${user.username}`
              )
            }
          >
            Save account type
          </button>
        </div>
      )}
      {!isSelf && !user.is_admin && (
        <ParentalControls user={user} onChanged={onChanged} />
      )}
      {isSelf ? (
        <p className="text-sm text-muted">
          Whether other accounts see your downloads is set under Downloads on
          shared devices, above.
        </p>
      ) : (
        <ShareDownloadsField
          checked={user.share_downloads}
          disabled={busy}
          onChange={(share) =>
            void run(
              { share_downloads: share },
              share
                ? `${user.username}’s downloads are shared`
                : `${user.username}’s downloads are private`
            )
          }
        />
      )}
      {isSelf ? (
        <p className="text-sm text-muted">
          Change your own password under Change password on this page; it asks
          for your current one.
        </p>
      ) : (
        <form
          className="max-w-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ password }, `Password reset for ${user.username}`).then(
              () => setPassword("")
            );
          }}
        >
          <Field
            label={`New password for ${user.username}`}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint="They are signed out everywhere."
          />
          <button type="submit" className={PANEL_BTN} disabled={busy}>
            Reset password
          </button>
        </form>
      )}
      {user.two_factor_enabled && !isSelf && (
        <div>
          <p className="mb-2 text-sm text-muted">
            {user.username} signs in with a code from an authenticator app. If
            they lost their phone and their recovery codes, turn it off so they
            can sign in with the password and set it up again.
          </p>
          <button
            type="button"
            className={PANEL_BTN}
            disabled={busy}
            onClick={async () => {
              const ok = await confirm({
                title: `Reset two-step sign-in for ${user.username}?`,
                body: "They are signed out everywhere and can sign in with their password alone (or are asked to set it up again if it is required).",
                confirmLabel: "Reset two-step sign-in",
                danger: true,
              });
              if (!ok) return;
              setBusy(true);
              setError(null);
              try {
                await api.resetUserTwoFactor(user.id);
                showToast(`Two-step sign-in is off for ${user.username}`);
                await onChanged();
              } catch (err) {
                setError(describe(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Reset two-step sign-in
          </button>
        </div>
      )}
      <UserDevices user={user} />
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
        {!isSelf && (
          <button
            type="button"
            className={PANEL_BTN}
            disabled={busy}
            onClick={() =>
              void run(
                { disabled: !user.disabled },
                user.disabled
                  ? `Enabled ${user.username}`
                  : `Disabled ${user.username}`
              )
            }
          >
            {user.disabled ? "Enable account" : "Disable account"}
          </button>
        )}
        <button
          type="button"
          className={button("danger", "sm")}
          disabled={busy}
          onClick={onDelete}
        >
          Delete user
        </button>
      </div>
    </div>
  );
}

/** One account's signed-in browsers; an administrator can end any of them. */
function UserDevices({ user }: { user: UserAccount }) {
  const { showToast, showError } = useToast();
  const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = `devices-${user.id}`;

  const reload = useCallback(async () => {
    try {
      setSessions(await api.listUserSessions(user.id));
    } catch (err) {
      showError(`Could not load devices: ${describe(err)}`);
    }
  }, [user.id, showError]);

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
      showError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} data-horde="user-devices">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold text-gray-100">
          {`Signed-in devices for ${user.username}`}
        </h3>
        {sessions !== null && sessions.length > 0 && (
          <button
            type="button"
            className={`${PANEL_BTN} ml-auto`}
            disabled={busy}
            onClick={() =>
              void run(
                () => api.revokeAllUserSessions(user.id),
                `Signed ${user.username} out everywhere`
              )
            }
          >
            Sign out everywhere
          </button>
        )}
      </div>
      {sessions === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted">Not signed in anywhere.</p>
      ) : (
        <SessionRows
          sessions={sessions}
          busy={busy}
          onSignOut={(s) =>
            void run(
              () => api.revokeUserSession(user.id, s.id),
              `Signed out ${s.device}`
            )
          }
        />
      )}
    </section>
  );
}
