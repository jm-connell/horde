import { removeKeysWithPrefix } from "./storage";

/** Clear Horde keys from this browser after a factory reset. */
export function clearHordeBrowserState(): void {
  removeKeysWithPrefix("horde", "local");
  removeKeysWithPrefix("horde", "session");
}
