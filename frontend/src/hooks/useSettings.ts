import { useCallback, useEffect, useState } from "react";
import type { ViewMode } from "../components/VideoPlayer";

export type SubtitleSize = "small" | "medium" | "large";

export type ChannelSort =
  | "recent_download"
  | "video_count"
  | "alphabetical"
  | "subscriber_count";

export type LibrarySort =
  | "added_at"
  | "published_at"
  | "title"
  | "duration"
  | "file_size"
  | "view_count"
  | "random";

export interface Settings {
  showDescription: boolean;
  subtitleSize: SubtitleSize;
  subtitleOffset: number;
  defaultPlaybackRate: number;
  volume: number;
  playbackMode: ViewMode;
  lastCustomChannel: string;
  showContinueWatching: boolean;
  channelSort: ChannelSort;
  channelOrder: "asc" | "desc";
  defaultLibrarySort: LibrarySort;
}

const DEFAULTS: Settings = {
  showDescription: true,
  subtitleSize: "medium",
  subtitleOffset: 12,
  defaultPlaybackRate: 1,
  volume: 1,
  playbackMode: "standard",
  lastCustomChannel: "",
  showContinueWatching: true,
  channelSort: "recent_download",
  channelOrder: "desc",
  defaultLibrarySort: "added_at",
};

const STORAGE_KEY = "horde.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return DEFAULTS;
  }
}

// Notify listeners in the same tab (the native "storage" event only fires in
// other tabs).
const EVENT = "horde:settings-changed";

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    const sync = () => setSettings(loadSettings());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = { ...loadSettings(), ...patch };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return [settings, update];
}
