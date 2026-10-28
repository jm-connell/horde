import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import UserAvatar from "../../components/auth/UserAvatar";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import ShareDownloadsField from "../../components/auth/ShareDownloadsField";
import type {
  DeviceSession,
  Permission,
  PermissionInfo,
  UserAccount,
} from "../../types";
import AccountTypeFields from "../settings/AccountTypeFields";
import { PANEL_BTN } from "../settings/constants";
import SessionRows from "./SessionRows";

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
      <section aria-labelledby="users-heading">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2
            id="users-heading"
            className="text-lg font-semibold text-gray-100"
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
        <p className="mb-4 text-sm text-muted">
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
                      className="rounded-sm bg-ink-800 px-1.5 py-0.5 text-xs text-emerald-400"
                      title="Signs in with a code from an authenticator app"
                    >
                      Two-step
                    </span>
                  )}
                  {u.disabled && (
                    <span className="rounded-sm bg-red-900/40 px-1.5 py-0.5 text-xs text-red-300">
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
        className="mb-3 text-base font-semibold text-gray-100"
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
          className={`${PANEL_BTN} text-red-300`}
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
