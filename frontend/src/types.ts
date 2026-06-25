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
  published_at: string | null;
  added_at: string;
  needs_review: boolean;
  platform: string | null;
  status: VideoStatus;
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
}

export type JobStatus = "queued" | "downloading" | "completed" | "error";

export interface DownloadJob {
  id: number;
  url: string;
  quality_preset: string;
  status: JobStatus;
  progress: number;
  title: string | null;
  error: string | null;
  video_id: number | null;
  created_at: string;
}

export interface ProgressEvent {
  status: string;
  progress?: number;
  title?: string;
  video_id?: number;
  error?: string;
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
