/**
 * Watch positions saved while the server could not be reached, kept in this
 * browser until the connection is back.
 *
 * Watch history is per account, but a device can be shared: someone watches
 * offline, someone else signs in later. Each queued save therefore records
 * who was signed in, and a flush only sends the saves of the account the
 * server says is signed in now. Other accounts' saves wait for their owner,
 * for at most PENDING_PROGRESS_MAX_AGE_MS.
 */
import {
  deletePendingProgress,
  getAllPendingProgress,
  putPendingProgress,
  type PendingProgress,
} from "./db";

/** Queued saves older than this are dropped instead of sent. */
export const PENDING_PROGRESS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PendingFlushPlan {
  /** Saves of the signed-in account, to send now. */
  send: PendingProgress[];
  /** Saves too old to be worth sending, whoever made them. */
  expire: PendingProgress[];
}

/**
 * Split the queue for a flush by `owner` (the account the server says is
 * signed in, or null when nobody is). Saves of other accounts are in neither
 * list: they stay queued.
 */
export function planPendingFlush(
  records: PendingProgress[],
  owner: number | null,
  now: number
): PendingFlushPlan {
  const send: PendingProgress[] = [];
  const expire: PendingProgress[] = [];
  for (const p of records) {
    if (now - p.at > PENDING_PROGRESS_MAX_AGE_MS) expire.push(p);
    else if (owner !== null && p.owner === owner) send.push(p);
  }
  return { send, expire };
}

export interface PendingProgressStore {
  put(p: PendingProgress): Promise<void>;
  getAll(): Promise<PendingProgress[]>;
  delete(owner: number, videoId: number): Promise<void>;
}

export interface FlushDeps {
  /** Ask the server who is signed in (null: nobody). Throws when unreachable. */
  whoAmI(): Promise<number | null>;
  /** Send one position to the server for the signed-in account. */
  send(videoId: number, positionSec: number): Promise<void>;
  /** The send failed because the video no longer exists (deleted). */
  isGone(err: unknown): boolean;
}

const indexedDbStore: PendingProgressStore = {
  put: putPendingProgress,
  getAll: getAllPendingProgress,
  delete: deletePendingProgress,
};

export class PendingProgressQueue {
  /** The account saves are queued for; null while nobody is signed in. */
  private owner: number | null = null;
  private flushing = false;
  private rerun = false;

  constructor(
    private store: PendingProgressStore = indexedDbStore,
    private now: () => number = Date.now
  ) {}

  /** Called whenever the signed-in account is (re)established or cleared. */
  setOwner(owner: number | null): void {
    this.owner = owner;
  }

  /** Queue a save for the signed-in account (dropped when nobody is). */
  async add(videoId: number, positionSec: number): Promise<void> {
    if (this.owner === null) return;
    await this.store.put({
      owner: this.owner,
      videoId,
      positionSec,
      at: this.now(),
    });
  }

  /**
   * Send the queued saves of whoever the server says is signed in. The server
   * is asked rather than trusting `owner`: the session cookie these requests
   * carry may belong to someone else by now (signed in from another tab), and
   * it is asked again before every send, so a sign-in change halfway through
   * ends the flush instead of recording the rest under the new account.
   * Stops at the first failure (other than a deleted video) and tries again
   * on the next call. A call made while a flush runs makes it run once
   * more when it ends (the account may have changed), instead of being lost.
   */
  async flush(deps: FlushDeps): Promise<void> {
    if (this.flushing) {
      this.rerun = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.rerun = false;
        await this.flushOnce(deps);
      } while (this.rerun);
    } finally {
      this.flushing = false;
    }
  }

  private async flushOnce(deps: FlushDeps): Promise<void> {
    try {
      const records = await this.store.getAll();
      if (records.length === 0) return;
      const owner = await deps.whoAmI();
      const plan = planPendingFlush(records, owner, this.now());
      for (const p of plan.expire) await this.store.delete(p.owner, p.videoId);
      for (const p of plan.send) {
        if ((await deps.whoAmI()) !== p.owner) {
          // Signed out or in as someone else meanwhile: the rest waits.
          this.rerun = true;
          return;
        }
        try {
          await deps.send(p.videoId, p.positionSec);
        } catch (err) {
          // A deleted video will never accept it: drop it and carry on,
          // rather than let it hold back every save queued after it.
          if (!deps.isGone(err)) throw err;
        }
        await this.store.delete(p.owner, p.videoId);
      }
    } catch {
      // Still unreachable, or IndexedDB unavailable: the next call retries.
    }
  }
}

/** The app's queue; AuthContext keeps its owner, offline/manager flushes it. */
export const pendingProgress = new PendingProgressQueue();
