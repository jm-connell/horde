/**
 * Whether the app is acting as an account that was unlocked with its password
 * on this device with no connection (see offline/accounts).
 *
 * The server has not confirmed that account, and the browser's session cookie
 * may belong to someone else, so nothing is sent live in its name. The flag is
 * cleared only once the server has answered who is signed in (AuthContext).
 */
import { getJson, removeItem, setJson } from "../storage";

const UNLOCK_KEY = "horde-offline-unlock";

/** The unlocked account's id, or null when the app acts as the server says. */
export function unlockedAccountId(): number | null {
  return getJson<number | null>(
    UNLOCK_KEY,
    (v): v is number => typeof v === "number",
    null
  );
}

export function setUnlockedAccount(userId: number): void {
  setJson(UNLOCK_KEY, userId);
}

export function clearUnlockedAccount(): void {
  removeItem(UNLOCK_KEY);
}
