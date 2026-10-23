import type { components } from "./api/schema";

type S = components["schemas"];

/* Wire shapes: aliases of the generated OpenAPI schema (src/api/schema.d.ts). */
export type VideoStatus = S["VideoStatus"];
export type MetadataSyncStatus = S["MetadataSyncStatus"];
export type BackgroundItem = S["BackgroundRead"];
export type ChannelSearchHit = S["ChannelSearchHit"];
export type SpriteMeta = S["SpriteMetaRead"];
export type SubtitleTrack = S["SubtitleTrack"];
export type SearchMatchReason = S["SearchMatchReason"];
export type Video = S["VideoRead"];
export type CompatState = S["CompatState"];
export type CompatSummary = S["CompatSummaryRead"];
export type VideoUpdate = S["VideoUpdate"];
export type ChannelStat = S["ChannelStat"];
export type ChannelFeedEntry = S["ChannelFeedEntry"];
export type NextPart = S["NextPartRead"];
export type ChannelFeedPage = S["ChannelFeedPage"];
export type ChannelCatalogStatusItem = S["ChannelCatalogStatusItem"];
export type ChannelAutodownload = S["ChannelAutodownloadRead"];
export type ChannelCatalogStatus = S["ChannelCatalogStatusResponse"];
export type JobStatus = S["JobStatus"];
export type DownloadDestination = S["DownloadDestination"];
export type DownloadJob = S["DownloadJobRead"];
export type DownloadPreview = S["DownloadPreview"];
export type StreamPreviewMeta = S["StreamPreviewMeta"];
export type StreamAi = S["StreamAiRead"];
export type StreamRelatedPage = S["StreamRelatedPage"];
export type DownloadBulkSkip = S["DownloadBulkSkip"];
export type DownloadBulkResult = S["DownloadBulkResult"];
export type DownloadQueueStatus = S["DownloadQueueStatus"];
export type TagStat = S["TagStat"];
export type FollowedChannel = S["FollowedChannelRead"];
export type FollowList = S["FollowListResponse"];
export type UnfollowResult = S["UnfollowResult"];
export type LiveChannel = S["LiveChannelRead"];
export type LiveList = S["LiveListResponse"];
export type ChannelLive = S["ChannelLiveResponse"];
export type StorageStats = S["StorageStats"];
/**
 * A deleted video in the trash. `reason` says why when a rule (not a person)
 * deleted it; the server does not send it yet, so it is optional here.
 */
export type TrashItem = S["TrashItemRead"] & { reason?: string | null };
export type TrashSummary = S["TrashSummary"];
export type TrashRestored = S["TrashRestored"];
export type TrashEmptied = S["TrashEmptied"];
export type AiSettings = S["AiSettingsRead"];
export type VideoAiChatMessage = S["VideoAiChatMessageRead"];
export type OpenRouterCosts = S["OpenRouterCostsRead"];
export type OpenRouterModel = S["OpenRouterModelRow"];
/** `ai` is always sent (the schema only marks it optional because it has a default). */
export type AppSettings = Omit<S["AppSettingsRead"], "ai"> & { ai: AiSettings };
/** `pulling` is always sent (the schema marks it optional because it has a default). */
export type AiStatus = Omit<S["AiStatusRead"], "pulling"> & {
  pulling: string[];
};
export type AiJobFailure = S["AiJobFailure"];
export type AiJobRow = S["AiJobRow"];
export type RecommendationSection = S["RecommendationSectionRead"];
export type RecommendationsResponse = S["RecommendationsRead"];
export type AiCurrentJob = S["AiCurrentJob"];
export type SystemStats = S["SystemStatsRead"];
export type ActivityTask = S["ActivityTaskRead"];
export type SystemActivity = S["SystemActivityRead"];
export type AiProcessResult = S["AiProcessResult"];
export type DuplicateGroup = S["DuplicateGroupRead"];
export type ImportScanResult = S["ScanResult"];
export type HealthStats = S["HealthFull"];
export type UpdateCheck = S["UpdateCheckRead"];
export type UpdateControl = S["UpdateControlRead"];
export type UpdateState = UpdateControl["state"];
export type PlaylistSource = S["PlaylistSource"];
export type PlaylistVisibility = S["PlaylistVisibility"];
export type Playlist = S["PlaylistRead"];
export type PlaylistDetail = S["PlaylistDetail"];
export type PlaylistPreviewEntry = S["PlaylistPreviewEntry"];
export type PlaylistPreviewData = S["PlaylistPreview"];
export type AuthUser = Omit<S["AuthUserRead"], "permissions"> & {
  permissions: Permission[];
};
export type AuthState = Omit<S["AuthState"], "user"> & {
  user: AuthUser | null;
};
export type UserAccount = Omit<S["UserRead"], "permissions"> & {
  permissions: Permission[];
};
export type PermissionInfo = Omit<S["PermissionInfo"], "name"> & {
  name: Permission;
};
export type UserCreateInput = Omit<
  S["UserCreate"],
  "permissions" | "is_admin"
> & {
  is_admin?: boolean;
  permissions?: Permission[];
};
export type UserUpdateInput = Omit<S["UserUpdate"], "permissions"> & {
  permissions?: Permission[];
};
export type MediaToken = S["MediaTokenRead"];

export type CompatStatus = "none" | "queued" | "running" | "ready" | "error";

export interface ProgressEvent {
  job_id?: number;
  status: string;
  progress?: number;
  /** Post-download step while status is processing. */
  stage?: string;
  title?: string;
  channel?: string;
  thumbnail_url?: string;
  quality_preset?: string;
  available_presets?: string[];
  video_id?: number;
  destination?: DownloadDestination;
  error?: string;
  error_kind?: string;
  reason?: string;
  total_bytes?: number;
  downloaded_bytes?: number;
  file_size?: number;
  quality_warning?: string;
  volume_warning?: string;
  /** Why a queued job is waiting for disk space; `null` once it is not. */
  held_reason?: string | null;
}

export interface DownloadOverrides {
  title_override?: string;
  channel_override?: string;
  notes_pending?: string;
  normalize_volume?: boolean;
  video_codec?: string;
  destination?: DownloadDestination;
}

export type AiSchedule = "on_download" | "on_request" | "timer" | "set_time";
export type AiWorkloadProfile = "light" | "normal" | "heavy";
export type AiSummaryLength = "short" | "medium" | "long";
export type AiChaptersMode = "on_download" | "on_watch";
export type AiGpuSource = "override" | "ollama" | "local" | "unknown";

/** OpenRouter catalog row from GET /api/ai/openrouter/models. */
/** Stable permission names (see docs/ops/authentication.md). */
export type Permission =
  | "delete_videos"
  | "download"
  | "offline_download"
  | "edit_metadata"
  | "manage_playlists"
  | "use_ai";
