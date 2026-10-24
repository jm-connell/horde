import type {
  StorageStats,
  SystemActivity,
  SystemStats,
  UpdateCheck,
  UpdateControl,
} from "../types";
import { type ReadOptions, request } from "./client";

export const systemApi = {
  storageStats(opts?: ReadOptions): Promise<StorageStats> {
    return request<StorageStats>("/api/stats/storage", opts);
  },

  getSystemStats(opts?: ReadOptions): Promise<SystemStats> {
    return request<SystemStats>("/api/system/stats", opts);
  },

  getSystemActivity(opts?: ReadOptions): Promise<SystemActivity> {
    return request<SystemActivity>("/api/system/activity", opts);
  },

  checkUpdates(refresh = false): Promise<UpdateCheck> {
    const qs = refresh ? "?refresh=true" : "";
    return request<UpdateCheck>(`/api/updates${qs}`);
  },

  updateControl(opts?: ReadOptions): Promise<UpdateControl> {
    return request<UpdateControl>("/api/system/update", opts);
  },

  requestUpdate(): Promise<UpdateControl> {
    return request<UpdateControl>("/api/system/update", { method: "POST" });
  },

  cancelUpdate(): Promise<UpdateControl> {
    return request<UpdateControl>("/api/system/update/cancel", {
      method: "POST",
    });
  },
};
