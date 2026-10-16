import { describe, expect, it } from "vitest";
import type { ResumePosition } from "./db";
import {
  DeviceResume,
  newerMark,
  serverMark,
  type ResumeStore,
} from "./resume";
import type { Video } from "../types";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const KILN = 5;

function memoryStore({
  positions = [] as ResumePosition[],
  pending = [] as ResumePosition[],
  copies = [KILN],
} = {}) {
  const key = (owner: number, videoId: number) => `${owner}:${videoId}`;
  const rows = new Map(positions.map((p) => [key(p.owner, p.videoId), p]));
  const queued = new Map(pending.map((p) => [key(p.owner, p.videoId), p]));
  const store: ResumeStore = {
    getPending: async (owner, videoId) => queued.get(key(owner, videoId)),
    get: async (owner, videoId) => rows.get(key(owner, videoId)),
    getAll: async (owner) =>
      [...rows.values()].filter((p) => p.owner === owner),
    put: async (p) => void rows.set(key(p.owner, p.videoId), p),
    forget: async (videoId) => {
      for (const [k, p] of rows) if (p.videoId === videoId) rows.delete(k);
    },
    hasCopy: async (videoId) => copies.includes(videoId),
  };
  return { store, rows: () => [...rows.values()] };
}

function video(positionSec: number, watchedAt: number | null): Video {
  return {
    id: KILN,
    title: "Kiln fire",
    last_position_sec: positionSec,
    last_watched_at:
      watchedAt === null ? null : new Date(watchedAt).toISOString(),
  } as Video;
}

function at(owner: number, positionSec: number, when: number): ResumePosition {
  return { owner, videoId: KILN, positionSec, at: when };
}

async function signedIn(owner: number, store: ResumeStore) {
  const resume = new DeviceResume(store, () => NOW);
  resume.setOwner(owner);
  // Let the owner's positions load.
  await new Promise((r) => setTimeout(r, 0));
  return resume;
}

describe("serverMark / newerMark", () => {
  it("reads a never-watched video as no mark", () => {
    expect(serverMark(video(0, null))).toBeNull();
    expect(serverMark(video(40, NOW))).toEqual({ positionSec: 40, at: NOW });
  });

  it("prefers the later mark", () => {
    const a = { positionSec: 1, at: NOW };
    const b = { positionSec: 2, at: NOW + 1 };
    expect(newerMark(a, b)).toBe(b);
    expect(newerMark(b, a)).toBe(b);
    expect(newerMark(null, a)).toBe(a);
    expect(newerMark(undefined, undefined)).toBeNull();
  });
});

describe("DeviceResume offline", () => {
  it("gives each account on the device its own place in a saved video", async () => {
    const { store } = memoryStore({
      positions: [at(1, 12, NOW - 2 * MIN), at(2, 6, NOW - MIN)],
    });
    const admin = await signedIn(1, store);
    expect((await admin.offline(video(0, null))).last_position_sec).toBe(12);
    const member = await signedIn(2, store);
    expect((await member.offline(video(0, null))).last_position_sec).toBe(6);
    const viewer = await signedIn(3, store);
    const fresh = await viewer.offline(video(0, null));
    expect(fresh.last_position_sec).toBe(0);
    expect(fresh.last_watched_at).toBeNull();
  });

  it("never returns the position the metadata was stored with", async () => {
    const { store } = memoryStore();
    const resume = await signedIn(1, store);
    expect((await resume.offline(video(99, NOW))).last_position_sec).toBe(0);
    resume.setOwner(null);
    expect((await resume.offline(video(99, NOW))).last_position_sec).toBe(0);
  });

  it("uses a newer queued save over the remembered place", async () => {
    const { store } = memoryStore({
      positions: [at(1, 12, NOW - 2 * MIN)],
      pending: [at(1, 30, NOW - MIN)],
    });
    const resume = await signedIn(1, store);
    expect((await resume.offline(video(0, null))).last_position_sec).toBe(30);
  });

  it("records only for the signed-in account", async () => {
    const { store, rows } = memoryStore();
    const resume = new DeviceResume(store, () => NOW);
    await resume.record(KILN, 10);
    expect(rows()).toEqual([]);
    resume.setOwner(2);
    await resume.record(KILN, 10);
    expect(rows()).toEqual([at(2, 10, NOW)]);
    expect(resume.getSnapshot().get(KILN)).toBe(10);
  });

  it("forgets every account's place when the copy is removed", async () => {
    const { store, rows } = memoryStore({
      positions: [at(1, 12, NOW), at(2, 6, NOW)],
    });
    const resume = await signedIn(1, store);
    expect(resume.getSnapshot().get(KILN)).toBe(12);
    await resume.forget(KILN);
    expect(rows()).toEqual([]);
    expect(resume.getSnapshot().has(KILN)).toBe(false);
  });
});

describe("DeviceResume online", () => {
  it("takes the server's position, reached on any device", async () => {
    const { store, rows } = memoryStore({
      positions: [at(1, 12, NOW - 10 * MIN)],
    });
    const resume = await signedIn(1, store);
    const v = await resume.online(video(240, NOW - MIN));
    expect(v.last_position_sec).toBe(240);
    // Remembered for playing the saved copy offline later.
    expect(rows()).toEqual([at(1, 240, NOW - MIN)]);
    expect((await resume.offline(video(0, null))).last_position_sec).toBe(240);
  });

  it("lets a newer unsent save on this device win", async () => {
    const { store } = memoryStore({ pending: [at(1, 30, NOW - MIN)] });
    const resume = await signedIn(1, store);
    const v = await resume.online(video(6, NOW - 5 * MIN));
    expect(v.last_position_sec).toBe(30);
    expect(v.last_watched_at).toBe(new Date(NOW - MIN).toISOString());
  });

  it("ignores an unsent save older than the server's", async () => {
    const { store } = memoryStore({ pending: [at(1, 30, NOW - 5 * MIN)] });
    const resume = await signedIn(1, store);
    expect((await resume.online(video(240, NOW - MIN))).last_position_sec).toBe(
      240
    );
  });

  it("ignores another account's unsent save", async () => {
    const { store } = memoryStore({ pending: [at(2, 30, NOW)] });
    const resume = await signedIn(1, store);
    expect((await resume.online(video(6, NOW - MIN))).last_position_sec).toBe(
      6
    );
  });

  it("does not remember videos that are not saved on the device", async () => {
    const { store, rows } = memoryStore({ copies: [] });
    const resume = await signedIn(1, store);
    await resume.online(video(240, NOW - MIN));
    expect(rows()).toEqual([]);
  });

  it("returns the server's copy when local storage fails", async () => {
    const { store } = memoryStore();
    store.getPending = async () => {
      throw new Error("IndexedDB unavailable");
    };
    const resume = await signedIn(1, store);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      expect((await resume.online(video(6, NOW))).last_position_sec).toBe(6);
    } finally {
      console.warn = warn;
    }
  });
});
