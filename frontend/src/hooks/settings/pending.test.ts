import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getItem, setJson } from "../../storage";
import { DEFAULTS } from "./defaults";
import { OWNER_KEY, PENDING_KEY, clearLocalSettings } from "./localStore";
import { normalizeSettings } from "./migrations";
import {
  adoptPendingOwner,
  clearPending,
  loadPending,
  markPending,
  overlayPending,
} from "./pending";
import { serverUiToSettingsPatch, settingsToServerUi } from "./serverUi";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: memoryStorage(),
    sessionStorage: memoryStorage(),
    dispatchEvent: () => true,
  });
});
afterEach(() => vi.unstubAllGlobals());

const ui = (sort: string) =>
  settingsToServerUi({ ...DEFAULTS, defaultLibrarySort: sort as never });

describe("overlayPending", () => {
  it("returns the server's preferences when nothing is pending", () => {
    const server = serverUiToSettingsPatch(ui("added_at"));
    expect(overlayPending(server, null)).toBe(server);
  });

  it("lets the unsent local change win over the server's older copy", () => {
    setJson(OWNER_KEY, 7);
    markPending(ui("title"));
    const merged = overlayPending(
      serverUiToSettingsPatch(ui("added_at")),
      loadPending(false)
    );
    expect(
      normalizeSettings({ ...DEFAULTS, ...merged }).defaultLibrarySort
    ).toBe("title");
  });
});

describe("pending marker ownership", () => {
  it("is found by the account that made it", () => {
    setJson(OWNER_KEY, 7);
    markPending(ui("title"));
    expect(loadPending(false)?.ui).toEqual(ui("title"));
  });

  it("is ignored by another account", () => {
    setJson(OWNER_KEY, 7);
    markPending(ui("title"));
    setJson(OWNER_KEY, 8);
    expect(loadPending(false)).toBeNull();
  });

  it("is dropped with the cache when the owner changes", () => {
    setJson(OWNER_KEY, 7);
    markPending(ui("title"));
    clearLocalSettings();
    expect(getItem(PENDING_KEY)).toBeNull();
  });

  it("belongs only to an administrator when it predates accounts", () => {
    markPending(ui("title"));
    expect(loadPending(false)).toBeNull();
    expect(loadPending(true)?.owner).toBeNull();
  });

  it("moves to the administrator who adopts the old preferences", () => {
    markPending(ui("title"));
    adoptPendingOwner(1);
    setJson(OWNER_KEY, 1);
    expect(loadPending(true)?.owner).toBe(1);
  });
});

describe("clearPending", () => {
  it("clears on the acknowledgement of that change", () => {
    const at = markPending(ui("title"));
    clearPending(at);
    expect(loadPending(true)).toBeNull();
  });

  it("keeps a newer change when an older one is acknowledged", () => {
    const first = markPending(ui("title"));
    setJson(PENDING_KEY, { owner: null, at: first + 5, ui: ui("duration") });
    clearPending(first);
    expect(loadPending(true)?.ui).toEqual(ui("duration"));
  });
});
