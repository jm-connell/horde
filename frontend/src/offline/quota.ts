/** Storage-quota helpers for offline downloads. */

export const OFFLINE_QUOTA_EVENT = "horde:offline-quota";

export interface OfflineQuotaDetail {
  videoId: number;
  title: string;
  /** Bytes still available after the partial download was removed, if known. */
  freeBytes: number | null;
}

/** Thrown up front when the download clearly cannot fit. */
export class StorageQuotaError extends Error {
  constructor(
    readonly neededBytes: number,
    readonly freeBytes: number
  ) {
    super(
      `Not enough storage (${formatBytes(neededBytes)} needed, ${formatBytes(freeBytes)} free)`
    );
    this.name = "StorageQuotaError";
  }
}

/** True for the browser's "storage is full" failure from Cache/IDB writes. */
export function isQuotaError(err: unknown): boolean {
  if (err instanceof StorageQuotaError) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return (
    e.name === "QuotaExceededError" ||
    e.name === "NS_ERROR_DOM_QUOTA_REACHED" || // Firefox
    e.code === 22 // legacy DOMException.QUOTA_EXCEEDED_ERR
  );
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1024 ** 2))} MB`;
}

export function quotaMessage(title: string, freeBytes: number | null): string {
  const space =
    freeBytes == null
      ? ""
      : ` ${formatBytes(freeBytes)} of device storage is free.`;
  return `Not enough storage to keep "${title}" offline.${space} Remove other offline videos and try again.`;
}
