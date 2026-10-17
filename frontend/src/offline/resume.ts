/**
 * Resume positions of videos saved on this device, kept per account.
 *
 * Watch history belongs to the account, and a device can be shared, so an
 * offline copy has no position of its own: each account that plays it on this
 * device gets its own record ([owner, videoId]). Opened online, a video starts
 * where the server says the account is (the place reached on any device),
 * unless this device holds a newer position it has not managed to send yet.
 * Opened offline, it starts where this account last was on this device.
 */
import type { Video } from "../types";
import {
  deleteResumePositions,
  getItem,
  getPendingProgress,
  getResumePosition,
  getResumePositions,
  putResumePosition,
  type ResumePosition,
} from "./db";

/** A position and when it was reached (ms since the epoch). */
export interface WatchMark {
  positionSec: number;
  at: number;
}

/** The account's position as the server reported it; null if never watched. */
export function serverMark(
  video: Pick<Video, "last_position_sec" | "last_watched_at">
): WatchMark | null {
  if (!video.last_watched_at) return null;
  const at = Date.parse(video.last_watched_at);
  if (!Number.isFinite(at)) return null;
  return { positionSec: video.last_position_sec, at };
}

/** The later of two marks (the first on a tie). */
export function newerMark(
  a: WatchMark | null | undefined,
  b: WatchMark | null | undefined
): WatchMark | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/** `video` with its watch fields set from `mark` (none: never watched). */
export function withMark(video: Video, mark: WatchMark | null): Video {
  return {
    ...video,
    last_position_sec: mark?.positionSec ?? 0,
    last_watched_at: mark ? new Date(mark.at).toISOString() : null,
  };
}

export interface ResumeStore {
  /** The account's queued, not yet sent, save for a video. */
  getPending(owner: number, videoId: number): Promise<WatchMark | undefined>;
  get(owner: number, videoId: number): Promise<ResumePosition | undefined>;
  getAll(owner: number): Promise<ResumePosition[]>;
  put(p: ResumePosition): Promise<void>;
  /** Drop every account's position in a video. */
  forget(videoId: number): Promise<void>;
  /** Whether the video is saved on this device. */
  hasCopy(videoId: number): Promise<boolean>;
}

const indexedDbStore: ResumeStore = {
  getPending: getPendingProgress,
  get: getResumePosition,
  getAll: getResumePositions,
  put: putResumePosition,
  forget: deleteResumePositions,
  hasCopy: async (videoId) => (await getItem(videoId)) !== undefined,
};

const NO_POSITIONS: ReadonlyMap<number, number> = new Map();

export class DeviceResume {
  /** The signed-in account; null while nobody is. */
  private owner: number | null = null;
  /** The owner's positions (seconds by video id), for lists. */
  private positions: ReadonlyMap<number, number> = NO_POSITIONS;
  private listeners = new Set<() => void>();

  constructor(
    private store: ResumeStore = indexedDbStore,
    private now: () => number = Date.now
  ) {}

  /** Called whenever the signed-in account is (re)established or cleared. */
  setOwner(owner: number | null): void {
    if (owner === this.owner) return;
    this.owner = owner;
    this.positions = NO_POSITIONS;
    this.notify();
    if (owner !== null) void this.load(owner);
  }

  getSnapshot = (): ReadonlyMap<number, number> => this.positions;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Remember where the signed-in account is in a video saved on this device. */
  async record(
    videoId: number,
    positionSec: number,
    at: number = this.now()
  ): Promise<void> {
    const owner = this.owner;
    if (owner === null) return;
    this.setPosition(videoId, positionSec);
    await this.store.put({ owner, videoId, positionSec, at });
  }

  /**
   * A video as the server sent it, with the position this account resumes
   * from: the server's, unless this device has a newer one it has not sent
   * yet. For a video saved on this device, the result is also remembered for
   * playing it offline later.
   */
  async online(video: Video): Promise<Video> {
    const owner = this.owner;
    if (owner === null) return video;
    try {
      const server = serverMark(video);
      const mark = newerMark(
        server,
        await this.store.getPending(owner, video.id)
      );
      if (mark && (await this.store.hasCopy(video.id))) {
        const local = await this.store.get(owner, video.id);
        if (!local || mark.at > local.at) {
          await this.record(video.id, mark.positionSec, mark.at);
        }
      }
      return mark === server ? video : withMark(video, mark);
    } catch (err) {
      console.warn("Could not read this device's resume positions", err);
      return video;
    }
  }

  /**
   * A video saved on this device, opened without the server: it resumes
   * where this account last was on this device, or from the start.
   */
  async offline(video: Video): Promise<Video> {
    const owner = this.owner;
    if (owner === null) return withMark(video, null);
    try {
      const [local, pending] = await Promise.all([
        this.store.get(owner, video.id),
        this.store.getPending(owner, video.id),
      ]);
      return withMark(video, newerMark(local, pending));
    } catch (err) {
      console.warn("Could not read this device's resume positions", err);
      return withMark(video, null);
    }
  }

  /** The offline copy is gone: forget every account's place in it. */
  async forget(videoId: number): Promise<void> {
    if (this.positions.has(videoId)) {
      const next = new Map(this.positions);
      next.delete(videoId);
      this.positions = next;
      this.notify();
    }
    await this.store.forget(videoId);
  }

  private async load(owner: number): Promise<void> {
    try {
      const rows = await this.store.getAll(owner);
      if (this.owner !== owner) return;
      // Positions recorded while this loaded are newer than the stored ones.
      this.positions = new Map([
        ...rows.map((p): [number, number] => [p.videoId, p.positionSec]),
        ...this.positions,
      ]);
      this.notify();
    } catch (err) {
      console.warn("Could not load this device's resume positions", err);
    }
  }

  private setPosition(videoId: number, positionSec: number): void {
    if (this.positions.get(videoId) === positionSec) return;
    this.positions = new Map(this.positions).set(videoId, positionSec);
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}

/** The app's instance; AuthContext keeps its owner. */
export const deviceResume = new DeviceResume();
