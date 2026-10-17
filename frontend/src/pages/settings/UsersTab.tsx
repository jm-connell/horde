import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { Field, FormError } from "../../components/auth/AuthForm";
import { useAuth } from "../../context/AuthContext";
import { useConfirm } from "../../context/ConfirmContext";
import { useToast } from "../../context/ToastContext";
import type { Permission, PermissionInfo, UserAccount } from "../../types";
import AccountTypeFields from "./AccountTypeFields";
import { PANEL_BTN } from "./constants";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

export default function UsersTab() {
  const { user: me } = useAuth();
  const { showToast, showError } = useToast();
  const confirm = useConfirm();
  const [users, setUsers] = useState<UserAccount[] | null>(null);
  const [catalog, setCatalog] = useState<PermissionInfo[]>([]);
  const [editing, setEditing] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      setUsers(await api.listUsers());
    } catch (err) {
      showError(`Could not load users: ${describe(err)}`);
    }
  }, [showError]);

  useEffect(() => {
    void reload();
    api
      .listPermissions()
      .then(setCatalog)
      .catch((err) =>
        showError(`Could not load permissions: ${describe(err)}`)
      );
  }, [reload, showError]);

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
    <div data-horde="users-tab" className="space-y-6">
      <section aria-labelledby="users-heading">
        <h2
          id="users-heading"
          className="mb-1 text-lg font-semibold text-gray-100"
        >
          Users
        </h2>
        <p className="mb-4 text-sm text-muted">
          Everyone signs in with their own account and has their own watch
          history. The library, playlists and downloads are shared.
        </p>
        {users === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
            {users.map((u) => (
              <li key={u.id} data-horde="user-row" className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-100">
                    {u.username}
                  </span>
                  {u.id === me?.id && (
                    <span className="text-xs text-muted">(you)</span>
                  )}
                  <span className="rounded bg-ink-800 px-1.5 py-0.5 text-xs text-gray-300">
                    {u.is_admin ? "Admin" : "Member"}
                  </span>
                  {u.disabled && (
                    <span className="rounded bg-red-900/40 px-1.5 py-0.5 text-xs text-red-300">
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
      <CreateUser catalog={catalog} onCreated={reload} />
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
      });
      showToast(`Created ${created.username}`);
      setUsername("");
      setPassword("");
      setIsAdmin(false);
      setGranted(null);
      await onCreated();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="create-user-heading">
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
        />
        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 8 characters. Share it with them yourself."
        />
        <AccountTypeFields
          isAdmin={isAdmin}
          granted={effective}
          catalog={catalog}
          onAdminChange={setIsAdmin}
          onGrantedChange={setGranted}
        />
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
  catalog,
  onChanged,
  onDelete,
}: {
  user: UserAccount;
  catalog: PermissionInfo[];
  onChanged: () => Promise<void>;
  onDelete: () => void;
}) {
  const { showToast } = useToast();
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
      <FormError message={error} />
      <div className="flex flex-wrap gap-2">
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
