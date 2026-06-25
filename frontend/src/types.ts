export type VideoStatus = "downloading" | "ready" | "error";

export interface Video {
  id: number;
  title: string;
  channel: string | null;
  tags: string[];
  description: string | null;
  source_url: string | null;
  has_thumbnail: boolean;
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
  tags?: string[];
  description?: string;
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
