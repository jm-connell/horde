import { getJson, removeItem, setJson } from "../../storage";
import { OWNER_KEY, PENDING_KEY } from "./localStore";
import { serverUiToSettingsPatch } from "./serverUi";
import type { Settings } from "./types";

/**
 * Preferences saved here but not yet acknowledged by the server.
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
  /** The `ui` blob that was (or is about to be) sent. */
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

/** Note an unsent change. Returns the stamp to pass to `clearPending` on ack. */
export function markPending(ui: Record<string, unknown>): number {
  const at = Date.now();
  setJson(PENDING_KEY, { owner: currentOwner(), at, ui } satisfies PendingSync);
  return at;
}

/** The server acknowledged the change stamped `at`; a newer one stays pending. */
export function clearPending(at: number): void {
  const stored = getJson<PendingSync | null>(PENDING_KEY, isPendingSync, null);
  if (stored && stored.at <= at) removeItem(PENDING_KEY);
}

/**
 * The unsent change that belongs to the signed-in account, if any. One that
 * belongs to someone else is never applied (and `clearLocalSettings` drops it
 * with the rest of that account's cache).
 */
export function loadPending(
  legacyPrefsMayMigrate: boolean
): PendingSync | null {
  const stored = getJson<PendingSync | null>(PENDING_KEY, isPendingSync, null);
  if (!stored) return null;
  const owner = currentOwner();
  if (stored.owner === owner) {
    // Unowned changes are only the administrator's to upload.
    return owner === null && !legacyPrefsMayMigrate ? null : stored;
  }
  return null;
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
  const stored = getJson<PendingSync | null>(PENDING_KEY, isPendingSync, null);
  if (stored && stored.owner === null)
    setJson(PENDING_KEY, { ...stored, owner: userId });
}
