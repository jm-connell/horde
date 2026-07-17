export type VideoStatus = "downloading" | "ready" | "error";

export interface SpriteMeta {
  interval_sec: number;
  tile_width: number;
  tile_height: number;
  columns: number;
  count: number;
  duration_sec: number;
}

export interface SubtitleTrack {
  lang: string;
  auto: boolean;
}

export interface Video {
  id: number;
  title: string;
  channel: string | null;
  channel_url: string | null;
  tags: string[];
  ai_tags: string[];
  user_tags: string[];
  description: string | null;
  notes: string | null;
  source_url: string | null;
  has_thumbnail: boolean;
  has_sprites?: boolean;
  subtitles: SubtitleTrack[];
  file_path: string;
  duration_sec: number | null;
  file_size: number | null;
  width_px: number | null;
  height_px: number | null;
  frame_rate: number | null;
  view_count: number | null;
  channel_subscriber_count: number | null;
  published_at: string | null;
  added_at: string;
  last_position_sec: number;
  last_watched_at: string | null;
  needs_review: boolean;
  platform: string | null;
  status: VideoStatus;
  metadata_synced_at: string | null;
  source_title: string | null;
  title_is_custom: boolean;
  subtitles_pending: boolean;
  ai_summary?: string | null;
  /** Length setting used when the summary was generated. */
  ai_summary_length?: "short" | "medium" | "long" | null;
}

export interface VideoUpdate {
  title?: string;
  channel?: string;
  channel_url?: string | null;
  tags?: string[];
  user_tag?: string;
  description?: string;
  notes?: string | null;
  source_url?: string;
  published_at?: string | null;
  thumbnail_url?: string;
}

export interface ChannelStat {
  channel: string;
  count: number;
  last_download_at: string | null;
  subscriber_count: number | null;
  channel_url: string | null;
}

export interface ChannelFeedEntry {
  id: string | null;
  url: string;
  title: string | null;
  duration: number | null;
  thumbnail_url: string | null;
  view_count: number | null;
  published_at: string | null;
  in_library: boolean;
  video_id: number | null;
  library_height_px: number | null;
  max_height: number | null;
}

export interface ChannelFeedPage {
  channel: string | null;
  channel_url: string | null;
  entries: ChannelFeedEntry[];
  has_more: boolean;
  indexing?: boolean;
  from_catalog?: boolean;
  catalog_indexed?: number;
  catalog_total?: number | null;
  catalog_complete?: boolean;
  catalog_status?: string | null;
}

export interface ChannelCatalogStatusItem {
  id: number | null;
  channel_url: string;
  channel_name: string | null;
  status: string;
  indexed_count: number;
  channel_total: number | null;
  complete: boolean;
  max_videos: number;
  phase: string | null;
  last_error: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string | null;
}

export interface ChannelCatalogStatus {
  enabled: boolean;
  running: boolean;
  current_channel: string | null;
  current_channel_url: string | null;
  current_phase: string | null;
  done: number;
  total: number;
  catalog_id: number | null;
  queue_depth: number;
  catalogs: ChannelCatalogStatusItem[];
}

export type JobStatus =
  | "queued"
  | "downloading"
  | "completed"
  | "error"
  | "cancelled";

export interface DownloadJob {
  id: number;
  url: string;
  quality_preset: string;
  status: JobStatus;
  progress: number;
  title: string | null;
  title_override: string | null;
  channel: string | null;
  channel_override: string | null;
  thumbnail_url: string | null;
  notes_pending: string | null;
  paused: boolean;
  error: string | null;
  video_id: number | null;
  replace_video_id?: number | null;
  file_size: number | null;
  created_at: string;
  video_missing?: boolean;
  superseded?: boolean;
}

export interface ProgressEvent {
  status: string;
  progress?: number;
  title?: string;
  channel?: string;
  video_id?: number;
  error?: string;
  total_bytes?: number;
  downloaded_bytes?: number;
  file_size?: number;
  quality_warning?: string;
  volume_warning?: string;
}

export interface DownloadPreview {
  is_playlist: boolean;
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  thumbnail_url: string | null;
  entry_count: number | null;
  view_count?: number | null;
  available_presets: string[];
  preset_sizes: Record<string, number>;
}

export interface StreamPreviewMeta {
  id: string | null;
  title: string | null;
  channel: string | null;
  channel_url: string | null;
  thumbnail_url: string | null;
  description: string | null;
  duration: number | null;
  view_count: number | null;
  source_url: string | null;
  preview_height: number | null;
  library_video_id: number | null;
  available_presets: string[];
}

export interface DownloadOverrides {
  title_override?: string;
  channel_override?: string;
  notes_pending?: string;
  normalize_volume?: boolean;
}

export interface DownloadQueueStatus {
  paused: boolean;
  active_count: number;
  queued_count: number;
}

export interface TagStat {
  tag: string;
  count: number;
}

export interface StorageStats {
  total_bytes: number;
  video_bytes: number;
  thumbnail_bytes: number;
  video_count: number;
}

export type AiSchedule = "on_download" | "on_request" | "timer" | "set_time";
export type AiWorkloadProfile = "light" | "normal" | "heavy";
export type AiSummaryLength = "short" | "medium" | "long";
export type AiGpuSource = "override" | "ollama" | "local" | "unknown";

export interface AiSettings {
  enabled: boolean;
  provider: string;
  base_url: string;
  embed_model: string;
  chat_model: string;
  schedule: AiSchedule;
  timer_hours: number;
  schedule_time: string;
  auto_pull_models: boolean;
  use_subtitles: boolean;
  enrich_tags: boolean;
  ai_summaries: boolean;
  summary_length: AiSummaryLength;
  ai_duplicates: boolean;
  category_min_score: number;
  workload_profile: AiWorkloadProfile;
  /** Optional GiB override for the Ollama machine GPU; null = autodetect. */
  vram_gb: number | null;
  paused: boolean;
}

export interface AppSettings {
  progress_expiry_days: number;
  metadata_sync_interval_hours: number;
  channel_catalog_enabled: boolean;
  channel_catalog_max_videos: number;
  ui: Record<string, unknown>;
  ai: AiSettings;
}

export interface AiStatus {
  enabled: boolean;
  provider: string;
  ready: boolean;
  reachable: boolean;
  base_url: string | null;
  embed_model: string;
  chat_model: string;
  embed_model_present: boolean;
  chat_model_present: boolean;
  pulling: string[];
  last_error: string | null;
  paused: boolean;
  schedule: AiSchedule;
  indexed_videos: number;
  total_videos: number;
  queue_depth: number;
  queue_breakdown: Record<string, number>;
  current_job: AiCurrentJob | string | null;
  workload_profile?: AiWorkloadProfile;
  recommended_profile?: AiWorkloadProfile;
  profile_locked?: boolean;
  lock_reason?: string | null;
  workload_warning?: string | null;
  vram_tier?: string;
  gpu_name?: string | null;
  vram_total_bytes?: number | null;
  gpu_source?: AiGpuSource;
  invent_sample_size?: number;
  invent_budget_chars?: number;
  models_match_profile?: boolean;
}

export interface RecommendationSection {
  title: string;
  kind?: string;
  seed_video_id: number | null;
  videos: Video[];
}

export interface RecommendationsResponse {
  categories: string[];
  sections: RecommendationSection[];
  hint?: string;
  has_more?: boolean;
}

export interface AiCurrentJob {
  kind: string;
  video_id: number | null;
  title: string | null;
  channel: string | null;
  has_thumbnail: boolean;
  model?: string | null;
}

export interface SystemStats {
  cpu_percent: number | null;
  cpu_model?: string | null;
  cpu_temp_c?: number | null;
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  ram_percent: number | null;
  gpu: {
    name?: string | null;
    util_percent: number | null;
    temp_c: number | null;
    vram_used_bytes: number | null;
    vram_total_bytes: number | null;
  } | null;
  disk?: {
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
  } | null;
}

export interface AiProcessResult {
  enqueued: number;
  breakdown: Record<string, number>;
  detail: string;
}

export interface DuplicateGroup {
  videos: Video[];
  match_type: string;
  ai_score: number | null;
  ai_verdict: string | null;
  ai_confidence: number | null;
  ai_reason: string | null;
}

export interface HealthStats {
  status: string;
  horde_sha?: string;
  horde_version?: string;
  yt_dlp_version: string;
  pot_provider: {
    status: string;
    url?: string;
    version?: string;
    detail?: string;
  } | null;
  ollama?: {
    enabled: boolean;
    ready: boolean;
    reachable: boolean;
    base_url?: string | null;
    pulling?: string[];
    last_error?: string | null;
  } | null;
  disk: { total_bytes: number; used_bytes: number; free_bytes: number } | null;
  library_video_count: number;
  review_pending_count: number;
  active_downloads: number;
}

export interface UpdateCheck {
  repo: string;
  current_sha: string;
  current_short: string;
  latest_sha: string | null;
  latest_short: string | null;
  latest_html_url: string | null;
  update_available: boolean;
  checked_at: string;
  error: string | null;
}

export type PlaylistSource = "user" | "youtube";

export interface Playlist {
  id: number;
  name: string;
  description: string | null;
  source_type: PlaylistSource;
  source_url: string | null;
  created_at: string;
  item_count: number;
}

export interface PlaylistDetail extends Playlist {
  videos: Video[];
}

export interface PlaylistPreviewEntry {
  id: string | null;
  url: string;
  title: string | null;
  channel: string | null;
  duration: number | null;
  thumbnail_url: string | null;
  view_count: number | null;
}

export interface PlaylistPreviewData {
  title: string | null;
  channel: string | null;
  entries: PlaylistPreviewEntry[];
}
