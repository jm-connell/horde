/** Clear Horde keys from this browser after a factory reset. */
export function clearHordeBrowserState(): void {
  const sweep = (store: Storage) => {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key && key.startsWith("horde")) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  };
  try {
    sweep(localStorage);
  } catch {
    // private mode
  }
  try {
    sweep(sessionStorage);
  } catch {
    // private mode
  }
}
