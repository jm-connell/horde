import type {
  AiJobRow,
  AiProcessResult,
  AiSettings,
  AiStatus,
  AppSettings,
  AuthState,
  AuthUser,
  MediaToken,
  PermissionInfo,
  UserAccount,
  UserCreateInput,
  UserUpdateInput,
  ChannelAutodownload,
  ChannelCatalogStatus,
  ChannelFeedPage,
  ChannelStat,
  DownloadBulkResult,
  DownloadJob,
  DownloadOverrides,
  DownloadPreview,
  DownloadQueueStatus,
  DuplicateGroup,
  ImportScanResult,
  OpenRouterCosts,
  Playlist,
  PlaylistDetail,
  PlaylistPreviewData,
  RecommendationsResponse,
  StorageStats,
  StreamPreviewMeta,
  SystemActivity,
  SystemStats,
  CompatState,
  CompatSummary,
  TagStat,
  UpdateCheck,
  Video,
  VideoUpdate,
  SpriteMeta,
} from "./types";
import type { ApiResponse } from "./api/typed";
import { connectivity } from "./offline/connectivity";
import { getItem as getOfflineItem, putPendingProgress } from "./offline/db";

/** One entry of a 422 response's `fields`: where the problem is and what it is. */
export interface ApiErrorField {
  loc: (string | number)[];
  msg: string;
}

/**
 * Every error response has the same body (see backend/app/errors.py):
 * `{detail, code, fields?, extra?}`. `message` is `detail`; branch on `code`.
 */
export class ApiError extends Error {
  code?: string;
  status: number;
  fields?: ApiErrorField[];
  extra?: Record<string, unknown>;

  constructor(
    message: string,
    extra?: {
      code?: string;
      status?: number;
      fields?: ApiErrorField[];
      extra?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.code = extra?.code;
    this.status = extra?.status ?? 0;
    this.fields = extra?.fields;
    this.extra = extra?.extra;
  }

  /** Stable failure kind of a link-reading error (`extra.error_kind`). */
  get errorKind(): string | undefined {
    const kind = this.extra?.error_kind;
    return typeof kind === "string" ? kind : undefined;
  }
}

/** Thrown without touching the network while the app is in offline mode. */
export function offlineError(): ApiError {
  return new ApiError("You're offline", { code: "offline", status: 0 });
}

export function isOfflineError(err: unknown): boolean {
  return err instanceof ApiError && err.code === "offline";
}

/** fetch() rejected (no response at all), as opposed to an HTTP error. */
function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError || isOfflineError(err);
}

/**
 * Every state-changing request must carry this header: the server refuses
 * mutations without it (app/security.py). A custom header forces a CORS
 * preflight, which no route grants, so other websites cannot send one.
 */
export const CSRF_HEADER = "X-Horde-Request";

/** Add the CSRF header to a non-GET request init. Safe methods pass through. */
export function withCsrf(init?: RequestInit): RequestInit | undefined {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS")
    return init;
  const headers = new Headers(init?.headers);
  headers.set(CSRF_HEADER, "1");
  return { ...init, headers };
}

/** Fired when the server says the session is gone (401). AuthProvider listens. */
export const AUTH_REQUIRED_EVENT = "horde:auth-required";
/** Fired on any 403; the detail is a user-facing sentence. */
export const PERMISSION_DENIED_EVENT = "horde:permission-denied";

function notifyAuthFailure(
  status: number,
  code: string | undefined,
  message: string
): void {
  if (status === 401 && code === "auth_required") {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  } else if (status === 403) {
    // Every 403 envelope (permission_denied, admin_required, csrf_rejected, ...)
    // carries a user-facing `detail`; show it instead of failing silently.
    window.dispatchEvent(
      new CustomEvent(PERMISSION_DENIED_EVENT, {
        detail: message || "Not allowed",
      })
    );
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Build the ApiError for a non-2xx response, notifying auth listeners. */
async function apiErrorFrom(resp: Response): Promise<ApiError> {
  let message = resp.statusText;
  let code: string | undefined;
  let fields: ApiErrorField[] | undefined;
  let extra: Record<string, unknown> | undefined;
  try {
    const body = await resp.json();
    if (typeof body.detail === "string") message = body.detail;
    if (typeof body.code === "string") code = body.code;
    if (Array.isArray(body.fields)) fields = body.fields;
    if (typeof body.extra === "object" && body.extra !== null)
      extra = body.extra;
  } catch {
    // non-JSON error body; keep status text
  }
  notifyAuthFailure(resp.status, code, message);
  return new ApiError(message, { status: resp.status, code, fields, extra });
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  // Offline mode: fail fast instead of hanging on a dead/slow connection.
  if (connectivity.offlineMode) throw offlineError();
  let resp: Response;
  const t0 = performance.now();
  try {
    resp = await fetch(url, withCsrf(init));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw err;
    }
    connectivity.reportRequest(performance.now() - t0, true);
    throw err;
  }
  connectivity.reportRequest(performance.now() - t0, false);
  if (!resp.ok) throw await apiErrorFrom(resp);
  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** Options every read accepts so React Query can cancel it. */
export interface ReadOptions {
  signal?: AbortSignal;
}

/** Event the offline manager listens for to keep resume positions current. */
export const OFFLINE_PROGRESS_EVENT = "horde:offline-progress";

function notifyOfflineProgress(videoId: number, positionSec: number): void {
  window.dispatchEvent(
    new CustomEvent(OFFLINE_PROGRESS_EVENT, {
      detail: { videoId, positionSec },
    })
  );
}

async function offlineVideo(id: number): Promise<Video> {
  const item = await getOfflineItem(id).catch(() => undefined);
  if (!item) throw new ApiError("Video not found", { status: 404 });
  return item.video;
}

export interface LibraryQuery {
  q?: string;
  channel?: string;
  tag?: string;
  sort?: string;
  order?: string;
  continue_watching?: boolean;
  watched_only?: boolean;
  seed?: number;
  signal?: AbortSignal;
}

/** One page of a cursor-paginated list; `next_cursor` is null on the last page. */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  /** Present only when the request asked for `include_total`. */
  total?: number | null;
}

/** Rows asked for per request; the server caps it at 500. */
export const PAGE_SIZE = 500;

/**
 * Walk a cursor-paginated list to its end. `onPage` sees everything fetched so
 * far after each page that is not the last, so a screen can paint the first page
 * while the rest loads in the background.
 */
async function collectPages<T>(
  fetchPage: (cursor: string | null) => Promise<Page<T>>,
  onPage?: (soFar: T[]) => void
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.next_cursor;
    if (cursor && onPage) onPage([...all]);
  } while (cursor);
  return all;
}

export interface ChannelQuery {
  sort?: string;
  order?: string;
  signal?: AbortSignal;
}

export interface ChannelFeedQuery {
  channel?: string;
  url?: string;
  offset?: number;
  limit?: number;
  /** When true, fetch/merge from YouTube (slower). Default prefers local catalog. */
  live?: boolean;
}

export const api = {
  getAuthState(): Promise<AuthState> {
    return request<AuthState>("/api/auth/state");
  },

  login(username: string, password: string): Promise<{ user: AuthUser }> {
    return request("/api/auth/login", jsonInit("POST", { username, password }));
  },

  bootstrapAdmin(
    username: string,
    password: string
  ): Promise<{ user: AuthUser }> {
    return request(
      "/api/auth/bootstrap",
      jsonInit("POST", { username, password })
    );
  },

  logout(): Promise<void> {
    return request<void>("/api/auth/logout", { method: "POST" });
  },

  changePassword(currentPassword: string, newPassword: string): Promise<void> {
    return request<void>(
      "/api/auth/password",
      jsonInit("POST", {
        current_password: currentPassword,
        new_password: newPassword,
      })
    );
  },

  getMediaToken(videoId: number): Promise<MediaToken> {
    return request<MediaToken>(`/api/videos/${videoId}/media-token`);
  },

  listUsers(): Promise<UserAccount[]> {
    return request<UserAccount[]>("/api/users");
  },

  listPermissions(): Promise<PermissionInfo[]> {
    return request<PermissionInfo[]>("/api/users/permissions");
  },

  createUser(input: UserCreateInput): Promise<UserAccount> {
    return request<UserAccount>("/api/users", jsonInit("POST", input));
  },

  updateUser(id: number, input: UserUpdateInput): Promise<UserAccount> {
    return request<UserAccount>(`/api/users/${id}`, jsonInit("PATCH", input));
  },

  deleteUser(id: number): Promise<void> {
    return request<void>(`/api/users/${id}`, { method: "DELETE" });
  },

  /** One page of the library. `listVideos` walks them all. */
  listVideosPage(
    params: LibraryQuery & {
      limit?: number;
      cursor?: string | null;
      include_total?: boolean;
    } = {}
  ): Promise<Page<Video>> {
    const { signal, ...query } = params;
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    return request<Page<Video>>(
      `/api/videos?${qs.toString()}`,
      signal ? { signal } : undefined
    );
  },

  /**
   * Every matching video. Pages are fetched back to back; `onPage` receives the
   * list so far after each page but the last (see `collectPages`).
   */
  listVideos(
    params: LibraryQuery = {},
    onPage?: (soFar: Video[]) => void
  ): Promise<Video[]> {
    return collectPages(
      (cursor) => api.listVideosPage({ ...params, limit: PAGE_SIZE, cursor }),
      onPage
    );
  },

  async saveProgress(id: number, positionSec: number): Promise<void> {
    notifyOfflineProgress(id, positionSec);
    // Offline-only device downloads have no server record.
    if (id < 0) return;
    try {
      await request<void>(`/api/videos/${id}/progress`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position_sec: positionSec }),
      });
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      // Sync when the connection is back (offline/manager flushes these).
      await putPendingProgress({
        videoId: id,
        positionSec,
        at: Date.now(),
      }).catch(() => undefined);
    }
  },

  /** Raw progress PATCH, used when flushing progress saved while offline. */
  syncProgress(id: number, positionSec: number): Promise<void> {
    return request<void>(`/api/videos/${id}/progress`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ position_sec: positionSec }),
    });
  },

  /** Falls back to the downloaded copy when offline or unreachable. */
  async getVideo(id: number): Promise<Video> {
    if (id < 0) return offlineVideo(id);
    try {
      return await request<Video>(`/api/videos/${id}`);
    } catch (err) {
      if (!isNetworkFailure(err)) throw err;
      const local = await getOfflineItem(id).catch(() => undefined);
      if (local) return local.video;
      throw err;
    }
  },

  getRelatedVideos(id: number, limit = 8, offset = 0): Promise<Video[]> {
    const qs = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    return request<Video[]>(`/api/videos/${id}/related?${qs.toString()}`);
  },

  updateVideo(id: number, payload: VideoUpdate): Promise<Video> {
    return request<Video>(`/api/videos/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  deleteVideo(id: number, deleteFile = false): Promise<void> {
    return request<void>(`/api/videos/${id}?delete_file=${deleteFile}`, {
      method: "DELETE",
    });
  },

  bulkDeleteVideos(ids: number[], deleteFiles = false): Promise<void> {
    return request<void>("/api/videos/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids, delete_files: deleteFiles }),
    });
  },

  bulkUpdateNotes(ids: number[], notes: string): Promise<void> {
    return request<void>("/api/videos/bulk-notes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: ids, notes }),
    });
  },

  refreshMetadata(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/refresh-metadata`, {
      method: "POST",
    });
  },

  refreshMetadataBulk(
    videoIds?: number[],
    fields?: string[]
  ): Promise<ApiResponse<"/api/videos/refresh-metadata", "post">> {
    return request("/api/videos/refresh-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_ids: videoIds ?? [],
        fields: fields ?? [],
      }),
    });
  },

  getMetadataSyncStatus(
    opts?: ReadOptions
  ): Promise<ApiResponse<"/api/videos/refresh-metadata/status", "get">> {
    return request("/api/videos/refresh-metadata/status", opts);
  },

  uploadThumbnail(id: number, file: File): Promise<Video> {
    const form = new FormData();
    form.append("file", file);
    return request<Video>(`/api/videos/${id}/thumbnail`, {
      method: "POST",
      body: form,
    });
  },

  generateThumbnailCandidates(
    id: number,
    count = 8
  ): Promise<
    ApiResponse<"/api/videos/{video_id}/thumbnail/candidates", "post">
  > {
    return request(`/api/videos/${id}/thumbnail/candidates?count=${count}`, {
      method: "POST",
    });
  },

  selectThumbnailCandidate(id: number, index: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/thumbnail/candidates/${index}`, {
      method: "POST",
    });
  },

  getSpriteMeta(id: number): Promise<SpriteMeta> {
    return request<SpriteMeta>(`/api/videos/${id}/sprites/meta`);
  },

  ensureSprites(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/sprites/generate", "post">> {
    return request(`/api/videos/${id}/sprites/generate`, { method: "POST" });
  },

  listChannels(params: ChannelQuery = {}): Promise<ChannelStat[]> {
    const { signal, ...query } = params;
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v) qs.set(k, String(v));
    });
    const text = qs.toString();
    return request<ChannelStat[]>(
      `/api/channels${text ? `?${text}` : ""}`,
      signal ? { signal } : undefined
    );
  },

  searchChannels(
    q: string,
    limit = 8
  ): Promise<ApiResponse<"/api/channels/search", "get">> {
    const qs = new URLSearchParams({
      q,
      limit: String(limit),
    });
    return request(`/api/channels/search?${qs.toString()}`);
  },

  getChannelFeed(params: ChannelFeedQuery = {}): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    });
    const query = qs.toString();
    return request<ChannelFeedPage>(
      `/api/channels/feed${query ? `?${query}` : ""}`
    );
  },

  searchChannelCatalog(params: {
    q: string;
    channel?: string;
    url?: string;
    limit?: number;
    semantic?: boolean;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.semantic === false) qs.set("semantic", "false");
    return request<ChannelFeedPage>(
      `/api/channels/catalog/search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  getChannelCatalogStatus(opts?: ReadOptions): Promise<ChannelCatalogStatus> {
    return request<ChannelCatalogStatus>("/api/channels/catalog/status", opts);
  },

  searchChannelYoutube(params: {
    q: string;
    channel?: string;
    url?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    if (params.limit != null) qs.set("limit", String(params.limit));
    return request<ChannelFeedPage>(
      `/api/channels/youtube-search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  searchYoutubeVideos(params: {
    q: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
  }): Promise<ChannelFeedPage> {
    const qs = new URLSearchParams();
    qs.set("q", params.q);
    if (params.limit != null) qs.set("limit", String(params.limit));
    if (params.offset != null) qs.set("offset", String(params.offset));
    return request<ChannelFeedPage>(
      `/api/youtube/search?${qs.toString()}`,
      params.signal ? { signal: params.signal } : undefined
    );
  },

  updateChannelYoutubeSearch(params: {
    channel?: string;
    url?: string;
    direct_youtube_search: boolean | null;
  }): Promise<ApiResponse<"/api/channels/catalog/youtube-search", "patch">> {
    return request("/api/channels/catalog/youtube-search", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        direct_youtube_search: params.direct_youtube_search,
      }),
    });
  },

  indexChannelCatalog(
    params: {
      channel?: string;
      url?: string;
      force?: boolean;
      mode?: "incremental" | "full";
    } = {}
  ): Promise<ApiResponse<"/api/channels/catalog/index", "post">> {
    return request("/api/channels/catalog/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        force: params.force ?? false,
        mode: params.mode ?? "incremental",
      }),
    });
  },

  getChannelAutodownload(params: {
    channel?: string;
    url?: string;
  }): Promise<ChannelAutodownload> {
    const qs = new URLSearchParams();
    if (params.channel) qs.set("channel", params.channel);
    if (params.url) qs.set("url", params.url);
    return request<ChannelAutodownload>(
      `/api/channels/autodownload?${qs.toString()}`
    );
  },

  updateChannelAutodownload(params: {
    channel?: string;
    url?: string;
    enabled: boolean;
    previous_mode: ChannelAutodownload["previous_mode"];
    previous_count?: number | null;
    quality_preset: string;
    include_completed_streams: boolean;
  }): Promise<ChannelAutodownload> {
    return request<ChannelAutodownload>("/api/channels/autodownload", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel ?? null,
        url: params.url ?? null,
        enabled: params.enabled,
        previous_mode: params.previous_mode,
        previous_count: params.previous_count ?? null,
        quality_preset: params.quality_preset,
        include_completed_streams: params.include_completed_streams,
      }),
    });
  },

  renameChannel(
    oldName: string,
    newName: string
  ): Promise<{ updated: number }> {
    return request<{ updated: number }>("/api/channels", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_name: oldName, new_name: newName }),
    });
  },

  listTags(): Promise<string[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "5000" });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<string>>(`/api/tags?${qs}`);
    });
  },

  tagStats(channel?: string, opts?: ReadOptions): Promise<TagStat[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "2000" });
      if (channel) qs.set("channel", channel);
      if (cursor) qs.set("cursor", cursor);
      return request<Page<TagStat>>(`/api/tags/stats?${qs}`, opts);
    });
  },

  storageStats(): Promise<StorageStats> {
    return request<StorageStats>("/api/stats/storage");
  },

  getAppSettings(): Promise<AppSettings> {
    return request<AppSettings>("/api/settings");
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

  getAiStatus(opts?: ReadOptions): Promise<AiStatus> {
    return request<AiStatus>("/api/ai/status", opts);
  },

  listAiJobs(status?: string, limit = 50): Promise<AiJobRow[]> {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    params.set("limit", String(limit));
    return request(`/api/ai/jobs?${params}`);
  },

  retryAiJob(
    jobId: number
  ): Promise<ApiResponse<"/api/ai/jobs/{job_id}/retry", "post">> {
    return request(`/api/ai/jobs/${jobId}/retry`, { method: "POST" });
  },

  retryFailedAiJobs(): Promise<
    ApiResponse<"/api/ai/jobs/retry-failed", "post">
  > {
    return request("/api/ai/jobs/retry-failed", { method: "POST" });
  },

  cancelAiJob(
    jobId: number
  ): Promise<ApiResponse<"/api/ai/jobs/{job_id}/cancel", "post">> {
    return request(`/api/ai/jobs/${jobId}/cancel`, { method: "POST" });
  },

  clearFailedAiJobs(
    keepDays = 0
  ): Promise<ApiResponse<"/api/ai/jobs/clear-failed", "post">> {
    return request(`/api/ai/jobs/clear-failed?keep_days=${keepDays}`, {
      method: "POST",
    });
  },

  testAiConnection(
    base_url?: string
  ): Promise<ApiResponse<"/api/ai/test", "post">> {
    return request("/api/ai/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_url: base_url || null }),
    });
  },

  testOpenRouterConnection(
    api_key?: string
  ): Promise<ApiResponse<"/api/ai/openrouter/test", "post">> {
    return request("/api/ai/openrouter/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: api_key || null }),
    });
  },

  getOpenRouterModels(
    opts?: ReadOptions
  ): Promise<ApiResponse<"/api/ai/openrouter/models", "get">> {
    return request("/api/ai/openrouter/models", opts);
  },

  getOpenRouterCosts(opts?: ReadOptions): Promise<OpenRouterCosts> {
    return request<OpenRouterCosts>("/api/ai/openrouter/costs", opts);
  },

  applyAiWorkload(
    profile?: "light" | "normal" | "heavy"
  ): Promise<ApiResponse<"/api/ai/apply-workload", "post">> {
    return request("/api/ai/apply-workload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: profile || null }),
    });
  },

  processAiLibrary(
    action:
      | "all"
      | "all_recent"
      | "all_full"
      | "embeds"
      | "reindex_embeds"
      | "missing_tags"
      | "full_tags"
      | "categories" = "all"
  ): Promise<AiProcessResult> {
    return request<AiProcessResult>("/api/ai/process", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
  },

  getCompat(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat`);
  },

  requestCompat(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefer_download: true }),
    });
  },

  /** Is the stored original playable by WebKit (Safari, every iOS browser)? */
  getSafariPrep(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat/safari`);
  },

  /** Queue the in-place Safari remux. GET /stream never does this itself. */
  requestSafariPrep(videoId: number): Promise<CompatState> {
    return request<CompatState>(`/api/videos/${videoId}/compat/safari`, {
      method: "POST",
    });
  },

  getCompatSummary(opts?: ReadOptions): Promise<CompatSummary> {
    return request<CompatSummary>("/api/compat/summary", opts);
  },

  startCompatBackfill(): Promise<ApiResponse<"/api/compat/backfill", "post">> {
    return request("/api/compat/backfill", { method: "POST" });
  },

  convertLibraryToH264(): Promise<
    ApiResponse<"/api/compat/convert-library", "post">
  > {
    return request("/api/compat/convert-library", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
  },

  cancelCompatJobs(
    kind?: "compat" | "convert"
  ): Promise<ApiResponse<"/api/compat/cancel", "post">> {
    return request("/api/compat/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(kind ? { kind } : {}),
    });
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

  pauseAi(): Promise<ApiResponse<"/api/ai/pause", "post">> {
    return request("/api/ai/pause", { method: "POST" });
  },

  resumeAi(): Promise<ApiResponse<"/api/ai/resume", "post">> {
    return request("/api/ai/resume", { method: "POST" });
  },

  getRecommendations(
    category?: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<RecommendationsResponse> {
    const params = new URLSearchParams();
    if (category) params.set("category", category);
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString() ? `?${params}` : "";
    return request<RecommendationsResponse>(`/api/ai/recommendations${qs}`);
  },

  refreshVideoTags(id: number): Promise<Video> {
    return request<Video>(`/api/videos/${id}/ai/refresh-tags`, {
      method: "POST",
    });
  },

  summarizeVideo(
    id: number,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Video> {
    const qs = opts?.force ? "?force=true" : "";
    return request<Video>(`/api/videos/${id}/ai/summarize${qs}`, {
      method: "POST",
      signal: opts?.signal,
    });
  },

  generateVideoChapters(
    id: number,
    opts?: { force?: boolean; signal?: AbortSignal }
  ): Promise<Video> {
    const qs = opts?.force ? "?force=true" : "";
    return request<Video>(`/api/videos/${id}/ai/chapters${qs}`, {
      method: "POST",
      signal: opts?.signal,
    });
  },

  getVideoAiChat(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/ai/chat", "get">> {
    return request(`/api/videos/${id}/ai/chat`);
  },

  clearVideoAiChat(
    id: number
  ): Promise<ApiResponse<"/api/videos/{video_id}/ai/chat", "delete">> {
    return request(`/api/videos/${id}/ai/chat`, {
      method: "DELETE",
    });
  },

  /**
   * Stream a chat turn via SSE. Calls ``onEvent`` for each parsed payload.
   * Resolves when the stream ends (done or error event also delivered).
   */
  async streamVideoAiChat(
    id: number,
    message: string,
    opts: {
      signal?: AbortSignal;
      onEvent: (event: Record<string, unknown>) => void;
    }
  ): Promise<void> {
    const resp = await fetch(
      `/api/videos/${id}/ai/chat`,
      withCsrf({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ message }),
        signal: opts.signal,
      })
    );
    if (!resp.ok) throw await apiErrorFrom(resp);
    if (!resp.body) {
      throw new Error("No response body");
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of raw.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload) continue;
          try {
            opts.onEvent(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // ignore malformed chunk
          }
        }
      }
    }
  },

  listDuplicateGroups(): Promise<DuplicateGroup[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<DuplicateGroup>>(`/api/review/groups?${qs}`);
    });
  },

  /** How many videos wait for review: one row and the server's count, not the list. */
  async reviewCount(opts?: ReadOptions): Promise<number> {
    const page = await request<Page<Video>>(
      "/api/review?limit=1&include_total=true",
      opts
    );
    return page.total ?? page.items.length;
  },

  listReview(): Promise<Video[]> {
    return collectPages((cursor) => {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) qs.set("cursor", cursor);
      return request<Page<Video>>(`/api/review?${qs}`);
    });
  },

  scanImport(): Promise<ImportScanResult> {
    return request<ImportScanResult>("/api/review/scan", { method: "POST" });
  },

  skipReview(id: number): Promise<Video> {
    return request<Video>(`/api/review/${id}/skip`, { method: "POST" });
  },

  skipImport(id: number): Promise<Video> {
    return request<Video>(`/api/review/${id}/skip`, { method: "POST" });
  },

  uploadImportVideo(
    file: File,
    onProgress?: (pct: number) => void
  ): Promise<Video> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/review/upload");
      xhr.setRequestHeader(CSRF_HEADER, "1");
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return;
        onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(xhr.response as Video);
          return;
        }
        let detail = xhr.statusText || "Upload failed";
        const body = xhr.response;
        if (body && typeof body === "object" && "detail" in body) {
          const d = (body as { detail: unknown }).detail;
          detail = typeof d === "string" ? d : detail;
        }
        reject(new Error(detail));
      };
      xhr.onerror = () => reject(new Error("Network error during upload"));
      xhr.onabort = () => reject(new Error("Upload aborted"));
      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },

  listPresets(): Promise<string[]> {
    return request<string[]>("/api/downloads/presets");
  },

  previewDownload(url: string): Promise<DownloadPreview> {
    return request<DownloadPreview>(
      `/api/downloads/preview?url=${encodeURIComponent(url)}`
    );
  },

  getPreviewMeta(url: string): Promise<StreamPreviewMeta> {
    return request<StreamPreviewMeta>(
      `/api/preview/meta?url=${encodeURIComponent(url)}`
    );
  },

  createDownload(
    url: string,
    quality_preset: string,
    overrides: DownloadOverrides = {}
  ): Promise<DownloadJob> {
    return request<DownloadJob>("/api/downloads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, quality_preset, ...overrides }),
    });
  },

  bulkCreateDownloads(
    urls: string[],
    quality_preset: string,
    extra: {
      destination?: DownloadJob["destination"];
      normalize_volume?: boolean;
      video_codec?: string;
    } = {}
  ): Promise<DownloadBulkResult> {
    return request<DownloadBulkResult>("/api/downloads/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, quality_preset, ...extra }),
    });
  },

  listJobs(opts?: ReadOptions): Promise<DownloadJob[]> {
    return request<DownloadJob[]>("/api/downloads", opts);
  },

  getJob(jobId: number): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}`);
  },

  updateJob(jobId: number, overrides: DownloadOverrides): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
  },

  cancelJob(jobId: number): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/cancel`, {
      method: "POST",
    });
  },

  retryJob(
    jobId: number,
    overrides: DownloadOverrides = {}
  ): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
  },

  changeJobQuality(
    jobId: number,
    quality_preset: string
  ): Promise<DownloadJob> {
    return request<DownloadJob>(`/api/downloads/${jobId}/quality`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality_preset }),
    });
  },

  dismissJob(jobId: number): Promise<void> {
    return request<void>(`/api/downloads/${jobId}`, { method: "DELETE" });
  },

  dismissFinished(): Promise<void> {
    return request<void>("/api/downloads/dismiss-finished", { method: "POST" });
  },

  getQueueStatus(opts?: ReadOptions): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/status", opts);
  },

  pauseQueue(): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/pause", {
      method: "POST",
    });
  },

  resumeQueue(): Promise<DownloadQueueStatus> {
    return request<DownloadQueueStatus>("/api/downloads/queue/resume", {
      method: "POST",
    });
  },

  redownloadVideo(
    id: number,
    quality_preset: string,
    normalize_volume = false,
    video_codec?: string
  ): Promise<Video> {
    return request<Video>(`/api/videos/${id}/redownload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quality_preset, normalize_volume, video_codec }),
    });
  },

  listPlaylists(): Promise<Playlist[]> {
    return request<Playlist[]>("/api/playlists");
  },

  getPlaylist(id: number): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${id}`);
  },

  createPlaylist(name: string, description?: string): Promise<Playlist> {
    return request<Playlist>("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description }),
    });
  },

  updatePlaylist(
    id: number,
    patch: {
      name?: string;
      description?: string;
      subscribed?: boolean;
      quality_preset?: string;
      cover_video_id?: number | null;
    }
  ): Promise<Playlist> {
    return request<Playlist>(`/api/playlists/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  },

  syncPlaylist(id: number): Promise<Playlist> {
    return request<Playlist>(`/api/playlists/${id}/sync`, { method: "POST" });
  },

  deletePlaylist(id: number): Promise<void> {
    return request<void>(`/api/playlists/${id}`, { method: "DELETE" });
  },

  addToPlaylist(playlistId: number, videoId: number): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId }),
    });
  },

  addUrlToPlaylist(playlistId: number, url: string): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },

  bulkAddToPlaylist(playlistId: number, videoIds: number[]): Promise<void> {
    return request<void>(`/api/playlists/${playlistId}/items/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: videoIds }),
    });
  },

  removeFromPlaylist(playlistId: number, videoId: number): Promise<void> {
    return request<void>(`/api/playlists/${playlistId}/items/${videoId}`, {
      method: "DELETE",
    });
  },

  reorderPlaylist(
    playlistId: number,
    videoIds: number[]
  ): Promise<PlaylistDetail> {
    return request<PlaylistDetail>(`/api/playlists/${playlistId}/reorder`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_ids: videoIds }),
    });
  },

  reorderPlaylists(playlistIds: number[]): Promise<Playlist[]> {
    return request<Playlist[]>("/api/playlists/reorder", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playlist_ids: playlistIds }),
    });
  },

  uploadPlaylistCover(id: number, file: File): Promise<Playlist> {
    const form = new FormData();
    form.append("file", file);
    return request<Playlist>(`/api/playlists/${id}/thumbnail`, {
      method: "POST",
      body: form,
    });
  },

  importPlaylist(
    url: string,
    quality_preset: string,
    opts: { name?: string; entries?: string[]; subscribe?: boolean } = {}
  ): Promise<Playlist> {
    return request<Playlist>("/api/playlists/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        quality_preset,
        name: opts.name,
        entries: opts.entries,
        subscribe: opts.subscribe ?? false,
      }),
    });
  },

  previewPlaylist(url: string): Promise<PlaylistPreviewData> {
    return request<PlaylistPreviewData>(
      `/api/playlists/preview?url=${encodeURIComponent(url)}`
    );
  },

  estimatePlaylistSizes(
    urls: string[]
  ): Promise<ApiResponse<"/api/playlists/estimate", "post">> {
    return request("/api/playlists/estimate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls }),
    });
  },
};

export function thumbnailUrl(video: Video): string | null {
  return video.has_thumbnail ? `/api/thumbnails/${video.id}` : null;
}

/** ~320px JPEG for download-list tiles; falls back to full size if missing. */
export function listThumbnailUrl(videoId: number): string {
  return `/api/thumbnails/${videoId}?size=sm`;
}

export function playlistCoverUrl(playlist: Playlist): string | null {
  if (!playlist.has_thumbnail) return null;
  if (playlist.has_custom_cover) {
    return `/api/playlists/${playlist.id}/thumbnail?v=c`;
  }
  if (playlist.thumbnail_video_id) {
    return listThumbnailUrl(playlist.thumbnail_video_id);
  }
  return null;
}

export function spritesMetaUrl(id: number): string {
  return `/api/videos/${id}/sprites/meta`;
}

export function spritesImageUrl(id: number): string {
  return `/api/videos/${id}/sprites`;
}

/**
 * Add a signed media token (`GET /api/videos/{id}/media-token`) to a media URL.
 * Only for URLs handed to a Cast or AirPlay receiver, which send no cookies; the
 * page's own `<video>` keeps using the cookie so offline cache keys do not change.
 */
export function withMediaToken(url: string, token: string): string {
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set("mt", token);
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
    ? parsed.href
    : `${parsed.pathname}${parsed.search}`;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).href;
}

export type Rendition = "original" | "compat";

export function streamUrl(
  id: number,
  rendition: Rendition = "original"
): string {
  return rendition === "compat"
    ? `/api/videos/${id}/stream?rendition=compat`
    : `/api/videos/${id}/stream`;
}

export function previewStreamUrl(url: string): string {
  return `/api/preview/stream?url=${encodeURIComponent(url)}`;
}

export function previewManifestUrl(url: string): string {
  return `/api/preview/manifest?url=${encodeURIComponent(url)}`;
}

export function previewSubtitleUrl(url: string, lang: string): string {
  return `/api/preview/subtitles?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`;
}

export function downloadFileUrl(id: number): string {
  return `/api/videos/${id}/file`;
}

export function deviceDownloadFileUrl(jobId: number): string {
  return `/api/downloads/${jobId}/file`;
}

export function triggerBrowserDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function subtitleUrl(id: number, lang: string): string {
  return `/api/videos/${id}/subtitles/${encodeURIComponent(lang)}`;
}
