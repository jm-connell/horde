import { useSyncExternalStore } from "react";
import { connectivity, type ConnectivityState } from "./connectivity";
import { bytesDone, type OfflineItem } from "./db";
import { offlineManager, type OfflineSnapshot } from "./manager";

export function useConnectivity(): ConnectivityState {
  return useSyncExternalStore(connectivity.subscribe, connectivity.getState);
}

/** True while the app is in offline mode (only downloaded videos shown). */
export function useOfflineMode(): boolean {
  return useConnectivity().status === "offline";
}

export function useOfflineDownloads(): OfflineSnapshot {
  return useSyncExternalStore(
    offlineManager.subscribe,
    offlineManager.getSnapshot
  );
}

export interface OfflineItemView {
  item: OfflineItem | undefined;
  /** 0..1 */
  progress: number;
  bytes: number;
}

export function itemProgress(
  item: OfflineItem | undefined,
  liveBytes: ReadonlyMap<number, number>
): OfflineItemView {
  if (!item) return { item, progress: 0, bytes: 0 };
  const bytes = Math.max(bytesDone(item), liveBytes.get(item.videoId) ?? 0);
  const progress =
    item.status === "complete"
      ? 1
      : item.totalBytes
        ? bytes / item.totalBytes
        : 0;
  return { item, progress, bytes };
}

export function useOfflineItem(
  videoId: number | null | undefined
): OfflineItemView {
  const snap = useOfflineDownloads();
  const item = videoId == null ? undefined : snap.byId.get(videoId);
  return itemProgress(item, snap.liveBytes);
}
