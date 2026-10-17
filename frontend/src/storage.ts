/**
 * The only module allowed to touch `localStorage` / `sessionStorage`.
 *
 * Browsers throw from the accessors themselves (blocked site data, private
 * windows, sandboxed iframes) and from `setItem` (quota). Every helper here
 * swallows those failures and falls back, so callers never repeat try/catch and
 * the UI keeps working with in-memory state when persistence is unavailable.
 *
 * Existing key names are part of the user's saved preferences and must never be
 * renamed. Changing the *shape* of what is stored under a key goes through
 * {@link STORAGE_MIGRATIONS}, which runs once per browser at boot.
 */

export type StorageArea = "local" | "session";

/** Minimal surface shared by `Storage` and test doubles. */
export type SafeStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const STORAGE_VERSION_KEY = "horde.storageVersion";

function area(which: StorageArea): Storage | null {
  try {
    const s = which === "local" ? window.localStorage : window.sessionStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function getItem(key: string, which: StorageArea = "local") {
  try {
    return area(which)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Returns false when the value could not be persisted (quota, blocked). */
export function setItem(
  key: string,
  value: string,
  which: StorageArea = "local"
): boolean {
  try {
    const s = area(which);
    if (!s) return false;
    s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(key: string, which: StorageArea = "local"): void {
  try {
    area(which)?.removeItem(key);
  } catch {
    // Nothing persisted, so nothing to remove.
  }
}

/**
 * Parse JSON stored under `key`. `validate` is a type guard over the parsed
 * value; anything missing, unparsable or failing validation yields `fallback`.
 */
export function getJson<T>(
  key: string,
  validate: (value: unknown) => value is T,
  fallback: T,
  which: StorageArea = "local"
): T {
  const raw = getItem(key, which);
  if (raw == null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validate(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function setJson(
  key: string,
  value: unknown,
  which: StorageArea = "local"
): boolean {
  try {
    return setItem(key, JSON.stringify(value), which);
  } catch {
    return false;
  }
}

/** Remove every key starting with `prefix` (used by the factory reset). */
export function removeKeysWithPrefix(
  prefix: string,
  which: StorageArea = "local"
): void {
  try {
    const s = area(which);
    if (!s) return;
    const keys: string[] = [];
    for (let i = 0; i < s.length; i += 1) {
      const key = s.key(i);
      if (key && key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) s.removeItem(key);
  } catch {
    // Nothing persisted, so nothing to remove.
  }
}

/** A `Storage`-shaped adapter for code that takes an injected store. */
export function safeStorage(which: StorageArea = "local"): SafeStorage {
  return {
    getItem: (key) => getItem(key, which),
    setItem: (key, value) => {
      setItem(key, value, which);
    },
    removeItem: (key) => removeItem(key, which),
  };
}

export interface StorageMigration {
  /** Strictly increasing; a migration runs once, when stored version < this. */
  version: number;
  description: string;
  run: () => void;
}

/** Keys the migrations below refer to; the owning modules keep their own copy. */
const SETTINGS_KEY = "horde.settings";
const LEGACY_PREVIEW_MUTE_KEY = "horde.previewMuted";
const SETTINGS_TAB_KEY = "horde.settings.tab";

/**
 * Ordered, append-only. Each step must be idempotent: a factory reset clears
 * the version key, so all steps run again against whatever is left.
 */
export const STORAGE_MIGRATIONS: readonly StorageMigration[] = [
  {
    version: 1,
    description: "Fold the standalone preview-mute flag into horde.settings",
    run: () => {
      const legacy = getItem(LEGACY_PREVIEW_MUTE_KEY);
      if (legacy == null) return;
      const muted =
        legacy === "1" || legacy === "true"
          ? true
          : legacy === "0" || legacy === "false"
            ? false
            : undefined;
      if (muted !== undefined) {
        const current = getJson<Record<string, unknown>>(
          SETTINGS_KEY,
          (v): v is Record<string, unknown> =>
            typeof v === "object" && v !== null && !Array.isArray(v),
          {}
        );
        // An explicit value in the settings blob wins over the legacy flag.
        if (current.previewMuted === undefined) {
          if (!setJson(SETTINGS_KEY, { ...current, previewMuted: muted })) {
            return; // keep the legacy key so the next boot can retry
          }
        }
      }
      removeItem(LEGACY_PREVIEW_MUTE_KEY);
    },
  },
  {
    version: 2,
    description: "Drop keys of removed features and superseded caches",
    run: () => {
      removeItem("horde.mini-pos"); // mini-player position is no longer saved
      removeItem("horde.decode-capability.v1"); // replaced by the .v2 cache
    },
  },
  {
    version: 3,
    description: "Rename the settings tab id 'downloads' to 'library'",
    run: () => {
      if (getItem(SETTINGS_TAB_KEY) === "downloads") {
        setItem(SETTINGS_TAB_KEY, "library");
      }
    },
  },
];

/** Run pending migrations. Call once at boot, before settings are read. */
export function runStorageMigrations(
  migrations: readonly StorageMigration[] = STORAGE_MIGRATIONS
): void {
  const stored = Number.parseInt(getItem(STORAGE_VERSION_KEY) ?? "", 10);
  let version = Number.isFinite(stored) ? stored : 0;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    try {
      migration.run();
    } catch (err) {
      // Stop here: later steps may depend on this one, and the version is not
      // advanced, so the next boot retries from the failed step.
      console.warn(
        `Storage migration ${migration.version} failed (${migration.description})`,
        err
      );
      return;
    }
    version = migration.version;
    setItem(STORAGE_VERSION_KEY, String(version));
  }
}
