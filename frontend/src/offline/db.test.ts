import { describe, expect, it } from "vitest";
import {
  DEVICE_ACCOUNTS_STORE,
  DB_VERSION,
  ITEMS_STORE,
  PENDING_PROGRESS_STORE,
  RESUME_POSITIONS_STORE,
  upgradeDb,
} from "./db";

/** The few IDBDatabase calls `upgradeDb` makes, recorded. */
function fakeDb(existing: string[]) {
  const stores = new Set(existing);
  const created: { name: string; keyPath: unknown }[] = [];
  const deleted: string[] = [];
  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string, options?: { keyPath?: unknown }) => {
      stores.add(name);
      created.push({ name, keyPath: options?.keyPath });
    },
    deleteObjectStore: (name: string) => {
      stores.delete(name);
      deleted.push(name);
    },
  } as unknown as IDBDatabase;
  return { db, stores, created, deleted };
}

describe("upgradeDb", () => {
  it("is at version 4", () => {
    expect(DB_VERSION).toBe(4);
  });

  it("adds only the accounts store going from version 3, keeping saved videos as they are", () => {
    const { db, created, deleted } = fakeDb([
      ITEMS_STORE,
      PENDING_PROGRESS_STORE,
      RESUME_POSITIONS_STORE,
    ]);
    upgradeDb(db, 3, null);
    expect(created).toEqual([
      { name: DEVICE_ACCOUNTS_STORE, keyPath: "userId" },
    ]);
    expect(deleted).toEqual([]);
  });

  it("creates every store in a new database", () => {
    const { stores } = (() => {
      const f = fakeDb([]);
      upgradeDb(f.db, 0, null);
      return f;
    })();
    expect([...stores].sort()).toEqual(
      [
        DEVICE_ACCOUNTS_STORE,
        ITEMS_STORE,
        PENDING_PROGRESS_STORE,
        RESUME_POSITIONS_STORE,
      ].sort()
    );
  });

  it("does nothing to a database that is already at version 4", () => {
    const f = fakeDb([
      ITEMS_STORE,
      PENDING_PROGRESS_STORE,
      RESUME_POSITIONS_STORE,
      DEVICE_ACCOUNTS_STORE,
    ]);
    upgradeDb(f.db, 4, null);
    expect(f.created).toEqual([]);
    expect(f.deleted).toEqual([]);
  });
});
