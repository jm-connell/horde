import { ApiError, api, withCsrf } from "../../api";
import { connectivity } from "../../offline/connectivity";
import { getJson, setJson } from "../../storage";
import { DEFAULTS } from "./defaults";
import {
  OWNER_KEY,
  SETTINGS_CHANGED_EVENT,
  clearLocalSettings,
  loadSettings,
  persistLocal,
} from "./localStore";
import { normalizeSettings } from "./migrations";
import {
  adoptPendingOwner,
  clearPending,
  loadPending,
  markPending,
  overlayPending,
} from "./pending";
import { serverUiToSettingsPatch, settingsToServerUi } from "./serverUi";
import type { Settings } from "./types";

export const SETUP_EVENT = "horde:setup-changed";

let syncTimer: ReturnType<typeof setTimeout> | null = null;

// The `ui` PATCHes below stay raw api calls: nothing reads `ui` from the query
// cache (app.settings), so they cannot leave it stale.
/** Module-level: one GET /api/settings for the whole app, not per useSettings mount. */
let serverHydratePromise: Promise<void> | null = null;
let serverHydrated = false;
/** Bumped when the signed-in user changes, so a GET still in flight is ignored. */
let hydrationGeneration = 0;
/** Only an administrator can own the preferences cached before accounts existed. */
let legacyPrefsMayMigrate = false;
let setupCompletedFlag: boolean | null = null;

/**
 * Tie this browser's cached preferences to the user who is signed in.
 *
 * The cache is cleared on sign-in and sign-out, but a session can also end or
 * change without either (it expired, the cookies were cleared, another tab
 * signed in as someone else). The next user must not inherit the previous
 * user's cache, and it must not be uploaded as theirs. When the owner differs,
 * or an unowned cache turns up under a member, the cache is dropped and the
 * server's preferences are fetched again. Unowned preferences (kept from before
 * accounts existed) may still be uploaded for an administrator.
 */
export function adoptSettingsOwner(userId: number, isAdmin: boolean): void {
  const stored = getJson<number | null>(
    OWNER_KEY,
    (v): v is number => typeof v === "number",
    null
  );
  if (stored === userId) return;
  const legacy = stored === null;
  if (legacy && isAdmin) {
    legacyPrefsMayMigrate = true;
    adoptPendingOwner(userId);
  } else {
    legacyPrefsMayMigrate = false;
    const hadHydrated = serverHydrated || serverHydratePromise !== null;
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    pendingSync = null;
    clearLocalSettings();
    hydrationGeneration += 1;
    serverHydrated = false;
    serverHydratePromise = null;
    if (hadHydrated) {
      void ensureServerHydration().then(() =>
        window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT))
      );
    }
  }
  setJson(OWNER_KEY, userId);
}

export function isServerHydrated(): boolean {
  return serverHydrated;
}

/** False only while the server has said setup is not finished. */
export function setupCompleted(): boolean {
  return setupCompletedFlag !== false;
}

export function markSetupCompleted(): void {
  setupCompletedFlag = true;
  window.dispatchEvent(new Event(SETUP_EVENT));
}

export async function flushSettingsSync(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  pendingSync = null;
  const ui = settingsToServerUi(loadSettings());
  try {
    await api.updateAppSettings({ ui });
    clearPending(Date.now());
  } catch {
    // ignore
  }
}

export function ensureServerHydration(): Promise<void> {
  if (serverHydrated) return Promise.resolve();
  if (serverHydratePromise) return serverHydratePromise;

  // On a dead or very slow connection, don't hold the boot screen until the
  // request times out: release it as soon as offline mode kicks in.
  const offlineGate = new Promise<void>((resolve) => {
    if (connectivity.offlineMode) return resolve();
    const unsub = connectivity.subscribe(() => {
      if (!connectivity.offlineMode) return;
      unsub();
      resolve();
    });
  });

  let signedOut = false;
  const generation = hydrationGeneration;
  const hydrate = api
    .getAppSettings()
    .then((remote) => {
      // The signed-in user changed while this was in flight: not their answer.
      if (generation !== hydrationGeneration) return;
      setupCompletedFlag = remote.setup_completed === true;
      const local = loadSettings();
      const ui = remote.ui && typeof remote.ui === "object" ? remote.ui : {};
      const hasServerUi = Object.keys(ui).length > 0;
      // A change this browser made that the server never acknowledged: the
      // server's copy is older than it, so it must not replace it.
      const pending = loadPending(legacyPrefsMayMigrate);

      if (hasServerUi) {
        const patch = overlayPending(serverUiToSettingsPatch(ui), pending);
        const next = normalizeSettings({
          ...local,
          ...patch,
          progressExpiryDays: remote.progress_expiry_days,
        });
        persistLocal(next);
        if (
          pending ||
          !Object.prototype.hasOwnProperty.call(ui, "preview_muted")
        ) {
          scheduleServerSync(next);
        }
      } else if (remote.setup_completed) {
        // Migrate local → server, only the preferences kept from before accounts
        if (pending) scheduleServerSync(local);
        const uiPayload = settingsToServerUi(local);
        if (legacyPrefsMayMigrate && Object.keys(uiPayload).length > 0) {
          api.updateAppSettings({ ui: uiPayload }).catch(() => undefined);
        }
        if (remote.progress_expiry_days !== local.progressExpiryDays) {
          persistLocal({
            ...local,
            progressExpiryDays: remote.progress_expiry_days,
          });
        }
      } else {
        // Incomplete setup with empty ui: do not push leftover local prefs up.
        persistLocal(
          normalizeSettings({
            ...DEFAULTS,
            progressExpiryDays: remote.progress_expiry_days,
          })
        );
      }
    })
    .catch((err) => {
      // Asked before signing in (a screen that reads settings can mount first):
      // not an answer. Leave hydration open so it runs again once signed in.
      if (err instanceof ApiError && err.status === 401) signedOut = true;
    });

  serverHydratePromise = Promise.race([hydrate, offlineGate]).finally(() => {
    if (generation !== hydrationGeneration) return;
    if (signedOut) {
      serverHydratePromise = null;
    } else {
      serverHydrated = true;
    }
  });

  return serverHydratePromise;
}

/** The settings the pending debounced sync will send. */
let pendingSync: Settings | null = null;
/** Identifies the change in `pendingSync` in the stored pending marker. */
let pendingStamp = 0;

export function scheduleServerSync(settings: Settings): void {
  if (syncTimer) clearTimeout(syncTimer);
  pendingSync = settings;
  const ui = settingsToServerUi(settings);
  const stamp = markPending(ui);
  pendingStamp = stamp;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    pendingSync = null;
    api
      .updateAppSettings({ ui })
      .then(() => clearPending(stamp))
      .catch(() => undefined);
  }, 300);
}

/**
 * Send a pending sync now, as the page is going away (reload, close, navigating
 * off, tab hidden). The 300 ms debounce timer dies with the page, so a change
 * made just before would otherwise be lost. `keepalive` lets the request
 * outlive the page.
 */
function flushPendingSync(): void {
  if (!pendingSync) return;
  const ui = settingsToServerUi(pendingSync);
  const stamp = pendingStamp;
  pendingSync = null;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  fetch(
    "/api/settings",
    withCsrf({
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ui }),
      credentials: "same-origin",
      keepalive: true,
    })
  )
    .then((res) => {
      if (res.ok) clearPending(stamp);
    })
    .catch(() => undefined);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushPendingSync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSync();
  });
}
