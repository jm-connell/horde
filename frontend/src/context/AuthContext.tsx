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
import EnrollTwoFactorPage from "../pages/EnrollTwoFactor";
import LoginPage from "../pages/Login";
import { adoptSettingsOwner, clearLocalSettings } from "../hooks/useSettings";
import { deviceAccounts } from "../offline/accounts";
import { connectivity } from "../offline/connectivity";
import type { DeviceAccount } from "../offline/db";
import { offlineManager } from "../offline/manager";
import { pendingProgress } from "../offline/pendingProgress";
import { deviceResume } from "../offline/resume";
import {
  clearUnlockedAccount,
  setUnlockedAccount,
  unlockedAccountId,
} from "../offline/unlock";
import { safeNextPath } from "../utils/authPaths";
import type { AuthState, AuthUser, Permission } from "../types";
import { getJson, removeItem, setJson } from "../storage";
import { clearHelpChatStorage } from "../components/helpChat";
import { useToast } from "./ToastContext";
import { button } from "../components/buttons";

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

/** The auth state of an account unlocked on this device (no server involved). */
function stateOfAccount(account: DeviceAccount): AuthState {
  return {
    users_exist: true,
    authenticated: true,
    setup_completed: true,
    user: {
      id: account.userId,
      username: account.username,
      is_admin: account.isAdmin,
      permissions: account.permissions,
      avatar_version: null,
      share_downloads: account.shareDownloads,
      two_factor_enabled: false,
      two_factor_enrollment_required: false,
    },
  };
}

/**
 * Before anything reads this user's preferences, make sure they are theirs,
 * and keep progress saved on this device (queued while offline, or the place
 * in a video saved for offline) under their account. An account unlocked
 * offline leaves the saved preferences alone: the server has not confirmed it.
 */
function bindDeviceStateToUser(state: AuthState, unlocked = false): void {
  const user = state.authenticated ? state.user : null;
  if (user && !unlocked) adoptSettingsOwner(user.id, user.is_admin);
  pendingProgress.setOwner(user?.id ?? null);
  deviceResume.setOwner(user?.id ?? null);
  deviceAccounts.setViewer(
    user ? { id: user.id, username: user.username } : null
  );
}

interface AuthContextValue {
  state: AuthState;
  user: AuthUser | null;
  isAdmin: boolean;
  /** Admins can do everything; members only what they were granted. */
  can: (permission: Permission) => boolean;
  refresh: () => Promise<void>;
  /**
   * Ends the session and reloads, so no state of this user survives. Goes to
   * the sign-in page, or to `to` (e.g. with a username filled in).
   */
  signOut: (to?: string) => Promise<void>;
  /** Username of the account unlocked on this device with no connection. */
  offlineAs: string | null;
  /**
   * With no connection: act as an account that keeps its downloads private,
   * after checking its password against this device. False if it is wrong.
   */
  unlockOffline: (userId: number, password: string) => Promise<boolean>;
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
  const [offlineAs, setOfflineAs] = useState<string | null>(null);
  const lastDenied = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const next = await api.getAuthState();
      // The server answered: whoever it says is signed in wins.
      clearUnlockedAccount();
      setOfflineAs(null);
      writeCachedState(next);
      bindDeviceStateToUser(next);
      if (next.authenticated && next.user) {
        void deviceAccounts.record(next.user);
      }
      setState(next);
      setFailed(false);
      // Signed in (again) without the connection changing, e.g. on this
      // device's sign-in form: send what this account saved while offline.
      if (next.authenticated) void offlineManager.flushPendingProgress();
    } catch (err) {
      const cached = readCachedState();
      const unreachable = isOfflineError(err) || err instanceof TypeError;
      const id = unreachable ? unlockedAccountId() : null;
      if (id !== null) await deviceAccounts.load();
      const unlocked =
        id === null ? undefined : deviceAccounts.getAccounts().get(id);
      if (unlocked) {
        const unlockedState = stateOfAccount(unlocked);
        bindDeviceStateToUser(unlockedState, true);
        setOfflineAs(unlocked.username);
        setState(unlockedState);
        setFailed(false);
      } else if (cached && unreachable) {
        bindDeviceStateToUser(cached);
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
      // The refusal may mean an administrator changed this account's role or
      // permissions: pick that up now, so the screens hide what it lost.
      void refresh();
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    window.addEventListener(PERMISSION_DENIED_EVENT, onDenied);
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      window.removeEventListener(PERMISSION_DENIED_EVENT, onDenied);
    };
  }, [refresh, showError]);

  // Back online while acting as an unlocked account: ask the server who is
  // really signed in.
  useEffect(
    () =>
      connectivity.subscribe(() => {
        const { status } = connectivity.getState();
        if (
          (status === "online" || status === "slow") &&
          unlockedAccountId() !== null
        ) {
          void refresh();
        }
      }),
    [refresh]
  );

  const signOut = useCallback(async (to = "/login") => {
    try {
      await api.logout();
    } catch {
      // Already signed out (401) or unreachable: leave anyway.
    }
    writeCachedState(null);
    clearUnlockedAccount();
    clearLocalSettings();
    clearHelpChatStorage();
    pendingProgress.setOwner(null);
    deviceResume.setOwner(null);
    deviceAccounts.setViewer(null);
    window.location.assign(to);
  }, []);

  const unlockOffline = useCallback(
    async (userId: number, password: string) => {
      const account = await deviceAccounts.unlock(userId, password);
      if (!account) return false;
      const unlockedState = stateOfAccount(account);
      setUnlockedAccount(account.userId);
      bindDeviceStateToUser(unlockedState, true);
      setOfflineAs(account.username);
      setState(unlockedState);
      return true;
    },
    []
  );

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
      offlineAs,
      unlockOffline,
    };
  }, [state, refresh, signOut, offlineAs, unlockOffline]);

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
            className={button("primary")}
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
  if (state.user?.two_factor_enrollment_required) {
    return <EnrollTwoFactorPage />;
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
