import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unlocked = vi.hoisted(() => ({ id: null as number | null }));
vi.mock("./offline/unlock", () => ({
  unlockedAccountId: () => unlocked.id,
}));

import { api } from "./api";
import { pendingProgress } from "./offline/pendingProgress";

describe("saveProgress", () => {
  const fetchMock = vi.fn();
  let queued: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    unlocked.id = null;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", new EventTarget());
    queued = vi.spyOn(pendingProgress, "add").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queued.mockRestore();
  });

  it("sends the position to the server as usual", async () => {
    await api.saveProgress(7, 42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(queued).not.toHaveBeenCalled();
  });

  it("sends a finish with the flag, and a plain save without it", async () => {
    await api.saveProgress(7, 0, true);
    await api.saveProgress(7, 0);
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body));
    expect(bodies).toEqual([
      { position_sec: 0, finished: true },
      { position_sec: 0 },
    ]);
  });

  it("queues a finish with its flag when the server cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await api.saveProgress(7, 0, true);
    expect(queued).toHaveBeenCalledWith(7, 0, true);
  });

  it("queues instead of sending while acting as an account unlocked offline", async () => {
    unlocked.id = 3;
    await api.saveProgress(7, 42);
    // The browser's session cookie may belong to someone else by now.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queued).toHaveBeenCalledWith(7, 42, false);
  });

  it("still queues when the server cannot be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await api.saveProgress(7, 42);
    expect(queued).toHaveBeenCalledWith(7, 42, false);
  });
});
