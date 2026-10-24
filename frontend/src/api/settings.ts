import type { AiSettings, AppSettings } from "../types";
import type { ApiResponse } from "./typed";
import { type ReadOptions, request } from "./client";

export const settingsApi = {
  getAppSettings(opts?: ReadOptions): Promise<AppSettings> {
    return request<AppSettings>("/api/settings", opts);
  },

  updateAppSettings(
    patch: Partial<Omit<AppSettings, "ai">> & { ai?: Partial<AiSettings> }
  ): Promise<AppSettings> {
    return request<AppSettings>("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  /** Delete the Jellyfin / Kodi / Plex files Horde wrote (in the background). */
  removeMediaSidecars(): Promise<
    ApiResponse<"/api/settings/media-sidecars/remove", "post">
  > {
    return request("/api/settings/media-sidecars/remove", { method: "POST" });
  },

  resetApp(
    eraseMedia: boolean,
    confirm: string
  ): Promise<ApiResponse<"/api/setup/reset", "post">> {
    return request("/api/setup/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ erase_media: eraseMedia, confirm }),
    });
  },

  uploadBackground(
    file: File
  ): Promise<ApiResponse<"/api/backgrounds", "post">> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/backgrounds", {
      method: "POST",
      body: form,
    });
  },

  listBackgrounds(): Promise<ApiResponse<"/api/backgrounds", "get">> {
    return request("/api/backgrounds");
  },

  deleteBackground(
    id: string
  ): Promise<ApiResponse<"/api/backgrounds/{bg_id}", "delete">> {
    return request(`/api/backgrounds/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },

  extractBackgroundPalette(
    id: string
  ): Promise<ApiResponse<"/api/backgrounds/{bg_id}/palette", "post">> {
    return request(`/api/backgrounds/${encodeURIComponent(id)}/palette`, {
      method: "POST",
    });
  },

  uploadFont(file: File): Promise<ApiResponse<"/api/fonts", "post">> {
    const form = new FormData();
    form.append("file", file);
    return request("/api/fonts", {
      method: "POST",
      body: form,
    });
  },

  deleteFont(
    id: string
  ): Promise<ApiResponse<"/api/fonts/{font_id}", "delete">> {
    return request(`/api/fonts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
};
