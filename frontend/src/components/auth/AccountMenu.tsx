import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import UserAvatar from "./UserAvatar";

const ITEM =
  "block w-full rounded-lg px-3 py-2 text-left text-sm text-gray-300 hover:bg-ink-800 hover:text-gray-100";

/**
 * Who is signed in, with Account settings (profile picture, password, and
 * for administrators the users) and Sign out.
 * `list` renders the same actions inline for the mobile navigation panel.
 */
export default function AccountMenu({
  variant,
  onNavigate,
}: {
  variant: "dropdown" | "list";
  onNavigate?: () => void;
}) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!user) return null;

  const close = () => {
    setOpen(false);
    onNavigate?.();
  };
  const items = (
    <>
      <Link
        to="/account"
        role={variant === "dropdown" ? "menuitem" : undefined}
        className={ITEM}
        onClick={close}
      >
        Account settings
      </Link>
      <button
        type="button"
        role={variant === "dropdown" ? "menuitem" : undefined}
        className={ITEM}
        onClick={() => void signOut()}
      >
        Sign out
      </button>
    </>
  );

  return (
    <>
      {variant === "list" ? (
        <div className="mx-auto max-w-[1920px] border-t border-ink-700 px-3 py-3 md:px-6">
          <p className="px-3 pb-1 text-xs text-muted">
            Signed in as{" "}
            <span data-horde="account-name" className="text-gray-300">
              {user.username}
            </span>
          </p>
          {items}
        </div>
      ) : (
        <div ref={rootRef} className="relative">
          <button
            type="button"
            data-horde="account-menu"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            onClick={() => setOpen((v) => !v)}
            className="ui-interactive flex max-w-[10rem] items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-gray-300 hover:text-gray-100"
          >
            <UserAvatar
              userId={user.id}
              username={user.username}
              version={user.avatar_version}
            />
            <span className="truncate">{user.username}</span>
          </button>
          {open && (
            <div
              id={menuId}
              role="menu"
              aria-label="Account"
              className="ui-panel ui-menu absolute right-0 top-full z-50 mt-1 w-48 rounded-xl bg-ink-900 p-1 shadow-xl ring-1 ring-ink-600"
            >
              {items}
            </div>
          )}
        </div>
      )}
    </>
  );
}
