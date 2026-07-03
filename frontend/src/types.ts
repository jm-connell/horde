export type VideoStatus = "downloading" | "ready" | "error";

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
  description: string | null;
  notes: string | null;
  source_url: string | null;
  has_thumbnail: boolean;
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
}

export interface VideoUpdate {
  title?: string;
  channel?: string;
  channel_url?: string | null;
  tags?: string[];
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
  file_size: number | null;
  created_at: string;
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
  available_presets: string[];
  preset_sizes: Record<string, number>;
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

export interface AppSettings {
  progress_expiry_days: number;
}

export interface HealthStats {
  status: string;
  yt_dlp_version: string;
  pot_provider: {
    status: string;
    url?: string;
    version?: string;
    detail?: string;
  } | null;
  disk: { total_bytes: number; used_bytes: number; free_bytes: number } | null;
  library_video_count: number;
  review_pending_count: number;
  active_downloads: number;
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
}

export interface PlaylistPreviewData {
  title: string | null;
  channel: string | null;
  entries: PlaylistPreviewEntry[];
}
