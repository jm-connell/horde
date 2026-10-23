import { useEffect, useRef, useState, type ReactNode } from "react";
import { REAUTH_REQUIRED_EVENT, type ReauthRequestDetail } from "../api";
import ReauthDialog from "../components/auth/ReauthDialog";
import { useAuth } from "./AuthContext";

/**
 * Answers the server's "confirm your password" (403 `reauth_required`): shows
 * one dialog however many requests are waiting, and lets every one of them
 * retry once it is confirmed (or fail if it is cancelled). The request layer
 * in `api/client.ts` raises the event; nothing else needs to know.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const waiting = useRef<((confirmed: boolean) => void)[]>([]);

  useEffect(() => {
    const onNeeded = (event: Event) => {
      const detail = (event as CustomEvent<ReauthRequestDetail>).detail;
      detail.handled = true;
      waiting.current.push(detail.settle);
      setOpen(true);
    };
    window.addEventListener(REAUTH_REQUIRED_EVENT, onNeeded);
    return () => window.removeEventListener(REAUTH_REQUIRED_EVENT, onNeeded);
  }, []);

  const finish = (confirmed: boolean) => {
    const settlers = waiting.current;
    waiting.current = [];
    setOpen(false);
    for (const settle of settlers) settle(confirmed);
  };

  return (
    <>
      {children}
      {open && (
        <ReauthDialog
          needsCode={user?.two_factor_enabled ?? false}
          onDone={finish}
        />
      )}
    </>
  );
}
