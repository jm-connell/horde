import type { components } from "./api/schema";

type S = components["schemas"];

/* Wire shapes: aliases of the generated OpenAPI schema (src/api/schema.d.ts). */
export type VideoStatus = S["VideoStatus"];
export type MetadataSyncStatus = S["MetadataSyncStatus"];
export type BackgroundItem = S["BackgroundRead"];
export type ChannelSearchHit = S["ChannelSearchHit"];
export type SpriteMeta = S["SpriteMetaRead"];
export type Storyboard = S["StoryboardRead"];
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
export type ChannelRetention = S["ChannelRetentionRead"];
export type ChannelRetentionPreview = S["ChannelRetentionPreview"];
/** The three optional limits of a retention rule. */
export type RetentionLimits = Pick<
  S["ChannelRetentionRead"],
  "keep_latest" | "max_age_days" | "remove_watched_after_days"
>;
export type ChannelCatalogStatus = S["ChannelCatalogStatusResponse"];
export type JobStatus = S["JobStatus"];
export type DownloadDestination = S["DownloadDestination"];
export type DownloadJob = S["DownloadJobRead"];
export type ClipCreate = S["ClipCreate"];
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
/** A deleted video in the trash. `reason` says why when a rule (not a person) deleted it. */
export type TrashItem = S["TrashItemRead"];
export type TrashSummary = S["TrashSummary"];
export type HistoryStats = S["HistoryStats"];
export type HistoryStatsRange = HistoryStats["range"];
export type HistoryStatsDay = S["HistoryStatsDay"];
export type TrashRestored = S["TrashRestored"];
export type TrashEmptied = S["TrashEmptied"];
export type AiSettings = S["AiSettingsRead"];
export type VideoAiChatMessage = S["VideoAiChatMessageRead"];
export type HelpChatTurn = S["HelpChatTurn"];
export type OpenRouterCosts = S["AiCostsRead"];
export type OpenRouterModel = S["AiModelRow"];
/** `models` / `embedding_models` / `presets` are always sent (defaults in the schema). */
export type AiConnectionTest = Omit<
  S["AiConnectionTest"],
  "models" | "embedding_models" | "presets"
> & {
  models?: OpenRouterModel[];
  embedding_models?: OpenRouterModel[];
  presets?: S["AiModelPreset"][];
};
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
export type DiscoverFeed = S["DiscoverFeedRead"];
export type DiscoverItem = S["DiscoverItemRead"];
export type DiscoverReason = S["DiscoverReasonRead"];
export type DiscoverStatus = S["DiscoverStatusRead"];
export type DiscoverRefresh = S["DiscoverRefreshRead"];
export type SuggestedChannel = S["SuggestedChannelRead"];
export type SuggestedChannels = S["SuggestedChannelsRead"];
export type RecFeedback = S["RecFeedbackRead"];
export type RecFeedbackList = S["RecFeedbackListRead"];
export type RecFeedbackKind = S["RecFeedbackWrite"]["kind"];
export type StreamWatch = S["StreamWatchRead"];
export type StreamWatchWrite = S["StreamWatchWrite"];
export type AiCurrentJob = S["AiCurrentJob"];
export type SystemStats = S["SystemStatsRead"];
export type ActivityTask = S["ActivityTaskRead"];
export type SystemActivity = S["SystemActivityRead"];
export type AiProcessResult = S["AiProcessResult"];
export type DuplicateGroup = S["DuplicateGroupRead"];
export type ImportScanResult = S["ScanResult"];
export type HealthStats = S["HealthFull"];
export type UpdateCheck = S["UpdateCheckRead"];
export type NotificationsConfig = S["NotificationsRead"];
export type NotificationTarget = S["NotificationTargetRead"];
export type NotificationEvent = S["NotificationEventRead"];
export type NotificationKind = S["NotificationTargetRead"]["kind"];
export type NotificationTargetCreate = S["NotificationTargetCreate"];
export type NotificationTargetUpdate = S["NotificationTargetUpdate"];
export type NotificationTargetDraft = S["NotificationTargetTest"];
export type NotificationTestResult = S["NotificationTestResult"];
export type UpdateControl = S["UpdateControlRead"];
export type UpdateState = UpdateControl["state"];
export type PlaylistSource = S["PlaylistSource"];
export type PlaylistVisibility = S["PlaylistVisibility"];
export type Playlist = S["PlaylistRead"];
export type PlaylistDetail = S["PlaylistDetail"];
export type PlaylistEntry = S["PlaylistEntry"];
export type PlaylistServerCopies = S["PlaylistServerCopies"];
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
  "permissions" | "is_admin" | "share_downloads"
> & {
  is_admin?: boolean;
  permissions?: Permission[];
  share_downloads?: boolean;
};
export type UserUpdateInput = Omit<S["UserUpdate"], "permissions"> & {
  permissions?: Permission[];
};
export type MediaToken = S["MediaTokenRead"];
export type TwoFactorStatus = S["TwoFactorStatus"];
export type TwoFactorSetup = S["TwoFactorSetup"];
export type SecurityChecklist = S["SecurityChecklistRead"];
export type SecurityCheckItem = S["SecurityCheckItem"];
export type TwoFactorRequirement = AppSettings["require_two_factor"];
/** One signed-in browser of an account. */
export type DeviceSession = S["SessionRead"];

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

/** Stable permission names (see docs/ops/authentication.md). */
export type Permission =
  | "delete_videos"
  | "download"
  | "offline_download"
  | "edit_metadata"
  | "manage_playlists"
  | "use_ai";
