/**
 * Who has signed in on this device, and who may see whose offline downloads.
 *
 * Saved videos belong to the account that saved them (`OfflineItem.owner`).
 * An account either shares its downloads with the other accounts on the device
 * or keeps them private. This is privacy between the people who share a
 * device, not encryption: the files stay readable to anyone with full access to
 * the browser profile.
 *
 * Because the connection may be gone, the sharing choice of every account that
 * signed in here is kept on the device (refreshed whenever the server answers).
 * For an account that does not share, the registry also keeps a check value for
 * its password, so the owner can unlock the downloads with no connection and
 * nobody is locked out of them (see `createVerifier`).
 */
import type { AuthUser } from "../types";
import {
  getAllDeviceAccounts,
  putDeviceAccount,
  type DeviceAccount,
  type OfflineItem,
  type PasswordVerifier,
} from "./db";

/** PBKDF2-SHA256 work factor (the OWASP recommendation for this function). */
export const VERIFIER_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/**
 * A check value for `password`: PBKDF2-SHA256 with a random 16-byte salt and a
 * 32-byte output. The password itself is never stored and the value never
 * leaves the device.
 */
export async function createVerifier(
  password: string,
  iterations: number = VERIFIER_ITERATIONS
): Promise<PasswordVerifier> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { salt: toBase64(salt), hash: toBase64(hash), iterations };
}

/** Whether `password` is the one `verifier` was made from. */
export async function checkVerifier(
  password: string,
  verifier: PasswordVerifier
): Promise<boolean> {
  try {
    const expected = fromBase64(verifier.hash);
    const actual = await derive(
      password,
      fromBase64(verifier.salt),
      verifier.iterations
    );
    if (actual.length !== expected.length) return false;
    // Compare every byte, so the time does not say where they differ.
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch (err) {
    console.warn("Could not check the password against this device", err);
    return false;
  }
}

export type AccountRegistry = ReadonlyMap<number, DeviceAccount>;

/**
 * Whether `viewer` (the signed-in account, null when nobody is) may see a
 * saved video: their own, one saved before owners were recorded, or one whose
 * owner shares downloads (or is not known on this device).
 */
export function isVisible(
  item: Pick<OfflineItem, "owner">,
  viewer: number | null,
  registry: AccountRegistry
): boolean {
  if (item.owner === undefined || item.owner === viewer) return true;
  const owner = registry.get(item.owner);
  return owner === undefined || owner.shareDownloads;
}

/** Private downloads of one other account, for the notice that mentions them. */
export interface HiddenGroup {
  owner: number;
  name: string;
  count: number;
  /** The device can check this account's password (unlock with no connection). */
  unlockable: boolean;
}

/** The items `viewer` may not see, counted per owner. */
export function hiddenGroups(
  items: readonly OfflineItem[],
  viewer: number | null,
  registry: AccountRegistry
): HiddenGroup[] {
  const groups = new Map<number, HiddenGroup>();
  for (const item of items) {
    if (item.owner === undefined || isVisible(item, viewer, registry)) continue;
    const group = groups.get(item.owner);
    if (group) {
      group.count += 1;
      continue;
    }
    const account = registry.get(item.owner);
    groups.set(item.owner, {
      owner: item.owner,
      name: account?.username ?? item.ownerName ?? "another account",
      count: 1,
      unlockable: account?.verifier !== undefined,
    });
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function sameAccount(a: DeviceAccount, b: DeviceAccount): boolean {
  return (
    a.username === b.username &&
    a.shareDownloads === b.shareDownloads &&
    a.isAdmin === b.isAdmin &&
    a.verifier === b.verifier &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((p, i) => p === b.permissions[i])
  );
}

/** The registry as stored; swapped for a memory one in tests. */
export interface AccountStore {
  getAll(): Promise<DeviceAccount[]>;
  put(account: DeviceAccount): Promise<void>;
}

const indexedDbStore: AccountStore = {
  getAll: getAllDeviceAccounts,
  put: putDeviceAccount,
};

/** The signed-in account as the device knows it. */
export interface Viewer {
  id: number;
  username: string;
}

const NO_ACCOUNTS: AccountRegistry = new Map();

export class DeviceAccounts {
  private accounts: AccountRegistry = NO_ACCOUNTS;
  private viewer: Viewer | null = null;
  private loading: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(
    private store: AccountStore = indexedDbStore,
    private iterations: number = VERIFIER_ITERATIONS
  ) {}

  /** Read the stored registry (once). Never rejects: the device may lack storage. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const rows = await this.store.getAll();
        // Whatever was recorded while this loaded is newer than what is stored.
        this.accounts = new Map([
          ...rows.map((a): [number, DeviceAccount] => [a.userId, a]),
          ...this.accounts,
        ]);
        this.notify();
      } catch (err) {
        console.warn("Could not read the accounts known to this device", err);
      }
    })();
    return this.loading;
  }

  getAccounts = (): AccountRegistry => this.accounts;

  getViewer = (): Viewer | null => this.viewer;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Called whenever the signed-in account is (re)established or cleared. */
  setViewer(viewer: Viewer | null): void {
    if (
      viewer?.id === this.viewer?.id &&
      viewer?.username === this.viewer?.username
    )
      return;
    this.viewer = viewer;
    this.notify();
  }

  /**
   * Note an account the server says is signed in. `password` is given only at
   * a sign-in (the one moment it is at hand): an account that does not share
   * gets a check value made from it, replacing the old one. Without it, the
   * old check value stays (it is kept across sign-outs). An account that
   * shares needs none, so its check value is deleted.
   */
  async record(user: AuthUser, password?: string): Promise<void> {
    await this.load();
    const existing = this.accounts.get(user.id);
    const shareDownloads = user.share_downloads;
    let verifier: PasswordVerifier | undefined;
    if (!shareDownloads) {
      verifier = existing?.verifier;
      if (password !== undefined) {
        try {
          verifier = await createVerifier(password, this.iterations);
        } catch (err) {
          // No WebCrypto outside a secure context (plain http), where nothing
          // can be saved for offline anyway.
          console.warn(
            "Could not make an offline unlock for this account",
            err
          );
        }
      }
    }
    const next: DeviceAccount = {
      userId: user.id,
      username: user.username,
      shareDownloads,
      isAdmin: user.is_admin,
      permissions: user.permissions,
      ...(verifier ? { verifier } : {}),
    };
    if (password === undefined && existing && sameAccount(existing, next))
      return;
    this.accounts = new Map(this.accounts).set(user.id, next);
    this.notify();
    try {
      await this.store.put(next);
    } catch (err) {
      console.warn("Could not remember this account on this device", err);
    }
  }

  /** Whether the signed-in account may see this saved video. */
  async canSee(item: Pick<OfflineItem, "owner">): Promise<boolean> {
    await this.load();
    return isVisible(item, this.viewer?.id ?? null, this.accounts);
  }

  /** The account, if `password` is right and the device holds its check value. */
  async unlock(
    userId: number,
    password: string
  ): Promise<DeviceAccount | null> {
    await this.load();
    const account = this.accounts.get(userId);
    if (!account?.verifier) return null;
    return (await checkVerifier(password, account.verifier)) ? account : null;
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

/** The app's instance; AuthContext keeps the viewer and the registry current. */
export const deviceAccounts = new DeviceAccounts();
