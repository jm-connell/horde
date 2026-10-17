import path from "node:path";
import { fileURLToPath } from "node:url";

/** Accounts seeded by backend/app/e2e_seed.py (app mode). */
export const ACCOUNTS = {
  admin: { username: "admin", password: "e2e-admin-password" },
  member: { username: "member", password: "e2e-member-password" },
  /** Can watch and use AI; no download, no delete, no playlist or metadata edits. */
  viewer: { username: "viewer", password: "e2e-viewer-password" },
} as const;

export type AccountName = keyof typeof ACCOUNTS;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Where global setup saves each account's signed-in browser state. */
export function storageStatePath(name: AccountName): string {
  return path.join(here, ".auth", `${name}.json`);
}
