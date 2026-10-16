import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Navigate, useLocation } from "react-router-dom";
import {
  api,
  AUTH_REQUIRED_EVENT,
  isOfflineError,
  PERMISSION_DENIED_EVENT,
} from "../api";
import LoadingIndicator from "../components/LoadingIndicator";
import CreateAdminPage from "../pages/CreateAdmin";
import LoginPage from "../pages/Login";
import { adoptSettingsOwner, clearLocalSettings } from "../hooks/useSettings";
import { safeNextPath } from "../utils/authPaths";
import type { AuthState, AuthUser, Permission } from "../types";
import { getJson, removeItem, setJson } from "../storage";
import { useToast } from "./ToastContext";

/** Last state that came from the server, so the installed app still opens offline. */
const CACHE_KEY = "horde-auth-state";
/** Minimum gap between session re-checks triggered by the tab becoming visible. */
const VISIBLE_REFRESH_MS = 3000;

function isAuthState(value: unknown): value is AuthState {
  return (
    typeof value === "object" && value !== null && "authenticated" in value
  );
}

function readCachedState(): AuthState | null {
  const parsed = getJson<AuthState | null>(CACHE_KEY, isAuthState, null);
  return parsed?.authenticated && parsed.user ? parsed : null;
}

function writeCachedState(state: AuthState | null): void {
  if (state?.authenticated) setJson(CACHE_KEY, state);
  else removeItem(CACHE_KEY);
}

/** Before anything reads this user's preferences, make sure they are theirs. */
function bindSettingsToUser(state: AuthState): void {
  if (state.authenticated && state.user) {
    adoptSettingsOwner(state.user.id, state.user.is_admin);
  }
}

interface AuthContextValue {
  state: AuthState;
  user: AuthUser | null;
  isAdmin: boolean;
  /** Admins can do everything; members only what they were granted. */
  can: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  /** Ends the session and reloads, so no state of this user survives. */
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { showError } = useToast();
  const [state, setState] = useState<AuthState | null>(null);
  const [failed, setFailed] = useState(false);
  const lastDenied = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getAuthState();
      writeCachedState(next);
      bindSettingsToUser(next);
      setState(next);
      setFailed(false);
    } catch (err) {
      const cached = readCachedState();
      if (cached && (isOfflineError(err) || err instanceof TypeError)) {
        bindSettingsToUser(cached);
        setState(cached);
        setFailed(false);
      } else {
        setFailed(true);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Another tab may have signed in as someone else or out: look again when
  // this one comes back to the front (throttled; one cheap GET).
  useEffect(() => {
    let last = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - last < VISIBLE_REFRESH_MS) return;
      last = now;
      void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  useEffect(() => {
    const onAuthRequired = () => void refresh();
    const onDenied = (e: Event) => {
      // Several requests can be refused at once; one toast is enough.
      const now = Date.now();
      if (now - lastDenied.current < 1500) return;
      lastDenied.current = now;
      const detail = (e as CustomEvent<string>).detail;
      showError(detail || "Your account is not allowed to do that", {
        key: "permission-denied",
      });
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    window.addEventListener(PERMISSION_DENIED_EVENT, onDenied);
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      window.removeEventListener(PERMISSION_DENIED_EVENT, onDenied);
    };
  }, [refresh, showError]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // Already signed out (401) or unreachable: leave anyway.
    }
    writeCachedState(null);
    clearLocalSettings();
    window.location.assign("/login");
  }, []);

  const value = useMemo<AuthContextValue | null>(() => {
    if (!state) return null;
    const user = state.user;
    return {
      state,
      user,
      isAdmin: !!user?.is_admin,
      can: (p) => !!user && (user.is_admin || user.permissions.includes(p)),
      refresh,
      signOut,
    };
  }, [state, refresh, signOut]);

  if (!value) {
    if (failed) {
      return (
        <main className="mx-auto max-w-md px-4 py-24 text-center">
          <h1 className="mb-2 text-xl font-semibold text-gray-100">
            Can’t reach Horde
          </h1>
          <p className="mb-4 text-sm text-gray-400">
            The server didn’t answer. Check that it is running and try again.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink-950 hover:bg-accent-soft"
          >
            Retry
          </button>
        </main>
      );
    }
    return <LoadingIndicator label="Loading" />;
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Chooses between the first-run account screen, sign-in and the app. Sign-in is a
 * real route (`/login?next=...`) so a deep link survives the round trip.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { state, refresh } = useAuth();
  const location = useLocation();

  if (!state.users_exist) {
    return (
      <CreateAdminPage wizard={!state.setup_completed} onCreated={refresh} />
    );
  }
  if (!state.authenticated) {
    if (location.pathname === "/login") return <LoginPage />;
    const here = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?next=${encodeURIComponent(here)}`} replace />;
  }
  if (location.pathname === "/login") {
    return (
      <Navigate
        to={safeNextPath(new URLSearchParams(location.search).get("next"))}
        replace
      />
    );
  }
  return <>{children}</>;
}
