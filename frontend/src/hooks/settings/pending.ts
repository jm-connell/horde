import { getJson, removeItem, setJson } from "../../storage";
import { OWNER_KEY, PENDING_KEY } from "./localStore";
import { serverUiToSettingsPatch } from "./serverUi";
import type { Settings } from "./types";

/**
 * Preferences changed here but not yet acknowledged by the server.
 *
 * A change is sent a moment after it is made, or as the page goes away. The
 * request of a page that is closing can reach the server after the next page's
 * read of the settings, so that read returns the older copy. Writing the
 * unsent change down first lets the next page keep it and send it again.
 */
export interface PendingSync {
  /** The account the change belongs to (null: made before accounts existed). */
  owner: number | null;
  /** Identifies this change, so an older acknowledgement does not clear a newer one. */
  at: number;
  /** Only the `ui` keys changed since the server last acknowledged; sent as a patch. */
  ui: Record<string, unknown>;
}

function isPendingSync(v: unknown): v is PendingSync {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Partial<PendingSync>;
  return (
    (p.owner === null || typeof p.owner === "number") &&
    typeof p.at === "number" &&
    typeof p.ui === "object" &&
    p.ui !== null
  );
}

function currentOwner(): number | null {
  return getJson<number | null>(
    OWNER_KEY,
    (v): v is number => typeof v === "number",
    null
  );
}

function stored(): PendingSync | null {
  return getJson<PendingSync | null>(PENDING_KEY, isPendingSync, null);
}

/** The stamp of the change pending now (before a request that will carry it), if any. */
export function pendingStamp(): number | null {
  return stored()?.at ?? null;
}

/** A marker older than this is dropped: it must not revert newer settings made elsewhere. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The marker this account left behind, or null (none, someone else's, or too old). */
function readOwn(
  now: number,
  legacyPrefsMayMigrate: boolean
): PendingSync | null {
  const marker = stored();
  if (!marker) return null;
  if (now - marker.at > PENDING_MAX_AGE_MS) {
    console.debug("Dropped an old unsynced settings change", marker.at);
    removeItem(PENDING_KEY);
    return null;
  }
  const owner = currentOwner();
  if (marker.owner !== owner) return null;
  // Unowned changes are only the administrator's to upload.
  return owner === null && !legacyPrefsMayMigrate ? null : marker;
}

/**
 * Note keys changed here and not yet sent. They merge with the keys still
 * pending, so the marker is everything the server has not acknowledged.
 * Returns the stamp to pass to `clearPending` and the patch to send.
 */
export function markPending(
  changed: Record<string, unknown>,
  now = Date.now()
): { at: number; ui: Record<string, unknown> } {
  const owner = currentOwner();
  const previous = readOwn(now, owner === null);
  const ui = { ...previous?.ui, ...changed };
  // Strictly increasing, even within one millisecond or if the clock steps
  // back, so an acknowledgement of an older change never clears a newer one.
  const at = Math.max(now, (stored()?.at ?? 0) + 1);
  setJson(PENDING_KEY, { owner, at, ui } satisfies PendingSync);
  return { at, ui };
}

/** The server acknowledged the change stamped `at`; a newer one stays pending. */
export function clearPending(at: number): void {
  const marker = stored();
  if (marker && marker.at <= at) removeItem(PENDING_KEY);
}

/**
 * The unsent change that belongs to the signed-in account, if any. One that
 * belongs to someone else is never applied (and `clearLocalSettings` drops it
 * with the rest of that account's cache); one that is too old is dropped.
 */
export function loadPending(
  legacyPrefsMayMigrate: boolean,
  now = Date.now()
): PendingSync | null {
  return readOwn(now, legacyPrefsMayMigrate);
}

/** The server's preferences with the unsent local change laid over them. */
export function overlayPending(
  serverPatch: Partial<Settings>,
  pending: PendingSync | null
): Partial<Settings> {
  if (!pending) return serverPatch;
  return { ...serverPatch, ...serverUiToSettingsPatch(pending.ui) };
}

/** The administrator took over the preferences kept from before accounts: so did their unsent change. */
export function adoptPendingOwner(userId: number): void {
  const marker = stored();
  if (marker && marker.owner === null)
    setJson(PENDING_KEY, { ...marker, owner: userId });
}
