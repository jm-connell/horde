import { describe, expect, it } from "vitest";
import {
  checkVerifier,
  createVerifier,
  DeviceAccounts,
  hiddenGroups,
  isVisible,
  type AccountRegistry,
  type AccountStore,
} from "./accounts";
import type { DeviceAccount, OfflineItem } from "./db";
import type { AuthUser } from "../types";

// Real PBKDF2 at the production cost takes a noticeable fraction of a second.
const FAST = 1000;

function account(
  userId: number,
  username: string,
  shareDownloads: boolean,
  extra: Partial<DeviceAccount> = {}
): DeviceAccount {
  return {
    userId,
    username,
    shareDownloads,
    isAdmin: false,
    permissions: ["offline_download"],
    ...extra,
  };
}

function registry(...accounts: DeviceAccount[]): AccountRegistry {
  return new Map(accounts.map((a) => [a.userId, a]));
}

function saved(videoId: number, owner?: number, ownerName?: string) {
  return { videoId, owner, ownerName } as OfflineItem;
}

const JON = 1;
const KID = 2;

describe("isVisible", () => {
  const accounts = registry(
    account(JON, "jon", false),
    account(KID, "kid", true)
  );

  it("always shows an account its own downloads", () => {
    expect(isVisible(saved(1, JON), JON, accounts)).toBe(true);
  });

  it("shows videos saved before owners were recorded to everyone", () => {
    expect(isVisible(saved(1), KID, accounts)).toBe(true);
    expect(isVisible(saved(1), null, accounts)).toBe(true);
  });

  it("shows another account's downloads only if it shares", () => {
    expect(isVisible(saved(1, KID), JON, accounts)).toBe(true);
    expect(isVisible(saved(1, JON), KID, accounts)).toBe(false);
    expect(isVisible(saved(1, JON), null, accounts)).toBe(false);
  });

  it("shows downloads of an owner this device has no record of", () => {
    expect(isVisible(saved(1, 99), KID, accounts)).toBe(true);
  });
});

describe("hiddenGroups", () => {
  it("counts the private downloads per owner, for the notice", () => {
    const accounts = registry(
      account(JON, "jon", false, {
        verifier: { salt: "s", hash: "h", iterations: 1 },
      }),
      account(KID, "kid", true),
      account(3, "ann", false)
    );
    const items = [
      saved(1, JON),
      saved(2, JON),
      saved(3, JON),
      saved(4, KID),
      saved(5, 3),
      saved(6),
    ];
    expect(hiddenGroups(items, KID, accounts)).toEqual([
      { owner: 3, name: "ann", count: 1, unlockable: false },
      { owner: JON, name: "jon", count: 3, unlockable: true },
    ]);
    expect(hiddenGroups(items, JON, accounts)).toEqual([
      { owner: 3, name: "ann", count: 1, unlockable: false },
    ]);
  });

  it("names an owner by the username stored with the video if unknown", () => {
    expect(hiddenGroups([saved(1, 7, "mia")], KID, registry())).toEqual([]);
    // Unknown owners count as sharing, so nothing is hidden; a known one is named.
    const accounts = registry(account(7, "mia-renamed", false));
    expect(hiddenGroups([saved(1, 7, "mia")], KID, accounts)[0].name).toBe(
      "mia-renamed"
    );
  });
});

describe("password verifier", () => {
  it("accepts the password it was made from and nothing else", async () => {
    const v = await createVerifier("correct horse", FAST);
    expect(v.iterations).toBe(FAST);
    expect(await checkVerifier("correct horse", v)).toBe(true);
    expect(await checkVerifier("correct horsf", v)).toBe(false);
    expect(await checkVerifier("", v)).toBe(false);
  });

  it("uses a 16-byte salt and a 32-byte key, and never holds the password", async () => {
    const v = await createVerifier("pw-secret-1", FAST);
    expect(atob(v.salt)).toHaveLength(16);
    expect(atob(v.hash)).toHaveLength(32);
    expect(JSON.stringify(v)).not.toContain("pw-secret-1");
  });

  it("salts each one, so equal passwords differ", async () => {
    const a = await createVerifier("same-password", FAST);
    const b = await createVerifier("same-password", FAST);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });

  it("is false, not a crash, for a damaged record", async () => {
    const v = await createVerifier("pw", FAST);
    expect(await checkVerifier("pw", { ...v, hash: "%%%" })).toBe(false);
  });
});

function memoryStore(rows: DeviceAccount[] = []) {
  const stored = new Map(rows.map((a) => [a.userId, a]));
  const store: AccountStore = {
    getAll: async () => [...stored.values()],
    put: async (a) => void stored.set(a.userId, a),
  };
  return { store, stored };
}

function user(
  id: number,
  username: string,
  share: boolean,
  extra: Partial<AuthUser> = {}
): AuthUser {
  return {
    id,
    username,
    is_admin: false,
    permissions: ["offline_download"],
    avatar_version: null,
    share_downloads: share,
    ...extra,
  };
}

describe("DeviceAccounts", () => {
  it("remembers who signed in and whether they share", async () => {
    const { store, stored } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", true));
    expect(accounts.getAccounts().get(JON)).toEqual({
      userId: JON,
      username: "jon",
      shareDownloads: true,
      isAdmin: false,
      permissions: ["offline_download"],
    });
    expect(stored.get(JON)?.verifier).toBeUndefined();
  });

  it("makes a check value at the sign-in of an account that does not share", async () => {
    const { store, stored } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", false), "jon-password");
    const verifier = stored.get(JON)?.verifier;
    expect(verifier).toBeDefined();
    expect(JSON.stringify(stored.get(JON))).not.toContain("jon-password");
    expect((await accounts.unlock(JON, "jon-password"))?.username).toBe("jon");
    expect(await accounts.unlock(JON, "not-it")).toBeNull();
  });

  it("keeps the check value when the account is seen again without a password", async () => {
    const { store, stored } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", false), "jon-password");
    const first = stored.get(JON)?.verifier;
    // The server's answer on a later visit (or someone else signing in).
    await accounts.record(user(JON, "jon", false));
    expect(stored.get(JON)?.verifier).toEqual(first);
    expect(await accounts.unlock(JON, "jon-password")).not.toBeNull();
  });

  it("replaces the check value at the next sign-in with a new password", async () => {
    const { store } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", false), "old-password");
    await accounts.record(user(JON, "jon", false), "new-password");
    expect(await accounts.unlock(JON, "old-password")).toBeNull();
    expect(await accounts.unlock(JON, "new-password")).not.toBeNull();
  });

  it("drops the check value when the account shares again", async () => {
    const { store, stored } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", false), "jon-password");
    await accounts.record(user(JON, "jon", true));
    expect(stored.get(JON)?.shareDownloads).toBe(true);
    expect(stored.get(JON)?.verifier).toBeUndefined();
    expect(await accounts.unlock(JON, "jon-password")).toBeNull();
  });

  it("has nothing to unlock for an account that shares or is unknown", async () => {
    const { store } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(KID, "kid", true), "kid-password");
    expect(await accounts.unlock(KID, "kid-password")).toBeNull();
    expect(await accounts.unlock(99, "x")).toBeNull();
  });

  it("loads what an earlier visit stored, offline", async () => {
    const { store } = memoryStore([account(JON, "jon", false)]);
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.load();
    expect(accounts.getAccounts().get(JON)?.username).toBe("jon");
  });

  it("answers whether the signed-in account may see a saved video", async () => {
    const { store } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    await accounts.record(user(JON, "jon", false), "jon-password");
    accounts.setViewer({ id: KID, username: "kid" });
    expect(await accounts.canSee(saved(1, JON))).toBe(false);
    accounts.setViewer({ id: JON, username: "jon" });
    expect(await accounts.canSee(saved(1, JON))).toBe(true);
  });

  it("tells listeners when the registry or the viewer changes", async () => {
    const { store } = memoryStore();
    const accounts = new DeviceAccounts(store, FAST);
    let calls = 0;
    accounts.subscribe(() => (calls += 1));
    accounts.setViewer({ id: JON, username: "jon" });
    const afterViewer = calls;
    expect(afterViewer).toBeGreaterThan(0);
    accounts.setViewer({ id: JON, username: "jon" });
    expect(calls).toBe(afterViewer);
    await accounts.record(user(JON, "jon", true));
    expect(calls).toBeGreaterThan(afterViewer);
  });

  it("does not rewrite an unchanged account on every refresh", async () => {
    const { store } = memoryStore();
    let puts = 0;
    const counting: AccountStore = {
      getAll: store.getAll,
      put: async (a) => {
        puts += 1;
        await store.put(a);
      },
    };
    const accounts = new DeviceAccounts(counting, FAST);
    await accounts.record(user(JON, "jon", true));
    await accounts.record(user(JON, "jon", true));
    expect(puts).toBe(1);
  });
});
