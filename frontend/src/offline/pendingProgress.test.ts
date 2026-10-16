import { describe, expect, it, vi } from "vitest";
import type { PendingProgress } from "./db";
import {
  PENDING_PROGRESS_MAX_AGE_MS,
  PendingProgressQueue,
  planPendingFlush,
  type PendingProgressStore,
} from "./pendingProgress";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function rec(owner: number, videoId: number, ageMs = 0): PendingProgress {
  return { owner, videoId, positionSec: 42, at: NOW - ageMs };
}

function memoryStore(initial: PendingProgress[] = []) {
  const rows = new Map(initial.map((p) => [`${p.owner}:${p.videoId}`, p]));
  const store: PendingProgressStore = {
    put: async (p) => void rows.set(`${p.owner}:${p.videoId}`, p),
    getAll: async () => [...rows.values()],
    delete: async (owner, videoId) => void rows.delete(`${owner}:${videoId}`),
  };
  return { store, rows: () => [...rows.values()] };
}

describe("planPendingFlush", () => {
  it("sends only the signed-in account's saves and keeps the others'", () => {
    const plan = planPendingFlush([rec(1, 10), rec(2, 10), rec(2, 11)], 2, NOW);
    expect(plan.send).toEqual([rec(2, 10), rec(2, 11)]);
    expect(plan.expire).toEqual([]);
  });

  it("sends nothing while nobody is signed in", () => {
    expect(planPendingFlush([rec(1, 10)], null, NOW)).toEqual({
      send: [],
      expire: [],
    });
  });

  it("expires saves older than the cap, whoever made them", () => {
    const old = PENDING_PROGRESS_MAX_AGE_MS + 1;
    const plan = planPendingFlush(
      [rec(1, 10, old), rec(2, 11, old), rec(1, 12, 29 * DAY)],
      2,
      NOW
    );
    expect(plan.expire).toEqual([rec(1, 10, old), rec(2, 11, old)]);
    expect(plan.send).toEqual([]);
  });
});

describe("PendingProgressQueue", () => {
  it("tags saves with the signed-in account and drops them when nobody is", async () => {
    const { store, rows } = memoryStore();
    const queue = new PendingProgressQueue(store, () => NOW);
    await queue.add(10, 5);
    expect(rows()).toEqual([]);
    queue.setOwner(7);
    await queue.add(10, 5);
    expect(rows()).toEqual([
      { owner: 7, videoId: 10, positionSec: 5, at: NOW },
    ]);
  });

  it("keeps two accounts' saves for the same video apart", async () => {
    const { store, rows } = memoryStore();
    const queue = new PendingProgressQueue(store, () => NOW);
    queue.setOwner(1);
    await queue.add(10, 5);
    queue.setOwner(2);
    await queue.add(10, 9);
    expect(rows()).toHaveLength(2);
  });

  it("flushes for the account the server reports, not the last one tagged", async () => {
    const { store, rows } = memoryStore([rec(1, 10), rec(2, 11)]);
    const queue = new PendingProgressQueue(store, () => NOW);
    queue.setOwner(1);
    const send = vi.fn(async () => undefined);
    await queue.flush({ whoAmI: async () => 2, send, isGone: () => false });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(11, 42);
    expect(rows()).toEqual([rec(1, 10)]);
  });

  it("keeps everything when the server can't be asked or a send fails", async () => {
    const { store, rows } = memoryStore([rec(1, 10), rec(1, 11)]);
    const queue = new PendingProgressQueue(store, () => NOW);
    await queue.flush({
      whoAmI: async () => {
        throw new TypeError("Failed to fetch");
      },
      send: vi.fn(),
      isGone: () => false,
    });
    expect(rows()).toHaveLength(2);

    const send = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await queue.flush({ whoAmI: async () => 1, send, isGone: () => false });
    expect(rows()).toEqual([rec(1, 11)]);
  });

  it("drops a save for a video the server no longer has and sends the rest", async () => {
    const { store, rows } = memoryStore([rec(1, 10), rec(1, 11), rec(1, 12)]);
    const queue = new PendingProgressQueue(store, () => NOW);
    const gone = new Error("Video not found");
    const send = vi.fn(async (videoId: number) => {
      if (videoId === 10) throw gone;
    });
    await queue.flush({
      whoAmI: async () => 1,
      send,
      isGone: (err) => err === gone,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(rows()).toEqual([]);
  });
});
