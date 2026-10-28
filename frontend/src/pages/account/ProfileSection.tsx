import { useRef, useState } from "react";
import { api } from "../../api";
import UserAvatar from "../../components/auth/UserAvatar";
import { useAuth } from "../../context/AuthContext";
import { useToast } from "../../context/ToastContext";
import { PANEL_BTN } from "../settings/constants";

/** Your name, role and profile picture. */
export default function ProfileSection() {
  const { user, isAdmin, refresh } = useAuth();
  const { showToast, showError } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const run = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await action();
      await refresh();
      showToast(done);
    } catch (err) {
      showError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(() => api.uploadAvatar(file), "Profile picture updated");
  };

  const hasPicture = user.avatar_version != null;

  return (
    <section aria-labelledby="profile-heading">
      <h2
        id="profile-heading"
        className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-400"
      >
        Profile
      </h2>
      <div className="flex flex-wrap items-center gap-4">
        <UserAvatar
          userId={user.id}
          username={user.username}
          version={user.avatar_version}
          size="lg"
        />
        <div className="min-w-0 space-y-2">
          <p className="text-base font-medium text-gray-100">
            {user.username}{" "}
            <span className="ml-1 rounded-sm bg-ink-800 px-1.5 py-0.5 align-middle text-xs font-normal text-gray-300">
              {isAdmin ? "Admin" : "Member"}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              aria-label="Profile picture file"
              onChange={onFile}
            />
            <button
              type="button"
              className={PANEL_BTN}
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {busy
                ? "Saving…"
                : hasPicture
                  ? "Change picture"
                  : "Upload picture"}
            </button>
            {hasPicture && (
              <button
                type="button"
                className={PANEL_BTN}
                disabled={busy}
                onClick={() =>
                  void run(() => api.removeAvatar(), "Profile picture removed")
                }
              >
                Remove picture
              </button>
            )}
          </div>
          <p className="text-xs text-muted">
            Any image; it is cropped to a square.
          </p>
        </div>
      </div>
    </section>
  );
}
