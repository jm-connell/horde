export type SettingsTab =
  | "appearance"
  | "library"
  | "playback"
  | "ai"
  | "system";

/** Legacy tab id redirected to library */
export type LegacySettingsTab = "downloads";

export type AiPane = "providers" | "features" | "jobs";

export type AiProviderPane = "local" | "openrouter";

export type AiProcessAction =
  | "all_recent"
  | "all_full"
  | "embeds"
  | "reindex_embeds"
  | "missing_tags"
  | "full_tags"
  | "categories";
