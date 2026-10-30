/**
 * Query keys, one place. A key starts with the area so `invalidateQueries({
 * queryKey: queryKeys.videos.all })` hits every list and detail of that area.
 */
export const queryKeys = {
  app: {
    settings: ["app", "settings"] as const,
    presets: ["app", "presets"] as const,
  },
  preview: {
    meta: (url: string) => ["preview", "meta", url] as const,
    download: (url: string) => ["preview", "download", url] as const,
    ai: (url: string) => ["preview", "ai", url] as const,
    related: (url: string) => ["preview", "related", url] as const,
  },
  discover: {
    status: ["discover", "status"] as const,
  },
  ai: {
    status: ["ai", "status"] as const,
    costs: ["ai", "costs"] as const,
    models: (target: "chat" | "embed", baseUrl: string) =>
      ["ai", "models", target, baseUrl] as const,
    helpCatalog: ["ai", "help-catalog"] as const,
    helpInfo: ["ai", "help-info"] as const,
  },
  system: {
    stats: ["system", "stats"] as const,
    activity: ["system", "activity"] as const,
    update: ["system", "update"] as const,
    storage: ["system", "storage"] as const,
    securityChecklist: ["system", "security-checklist"] as const,
  },
  compat: {
    summary: ["compat", "summary"] as const,
  },
  channels: {
    all: ["channels"] as const,
    list: (sort: string | undefined, order: string | undefined) =>
      ["channels", "list", sort ?? "", order ?? ""] as const,
    catalogStatus: ["channels", "catalog-status"] as const,
    avatar: (url: string) => ["channels", "avatar", url] as const,
    retention: (channel: string) => ["channels", "retention", channel] as const,
    retentionPreview: (channel: string, limits: unknown) =>
      ["channels", "retention-preview", channel, limits] as const,
  },
  metadata: {
    syncStatus: ["metadata", "sync-status"] as const,
  },
  review: {
    count: ["review", "count"] as const,
  },
  downloads: {
    jobs: ["downloads", "jobs"] as const,
    progress: ["downloads", "progress"] as const,
    queue: ["downloads", "queue"] as const,
  },
  videos: {
    all: ["videos"] as const,
    lists: ["videos", "list"] as const,
    list: (filters: unknown) => ["videos", "list", filters] as const,
    detail: (id: number) => ["videos", "detail", id] as const,
    related: (id: number) => ["videos", "related", id] as const,
  },
  tags: {
    all: ["tags"] as const,
    stats: (channel: string | undefined) =>
      ["tags", "stats", channel ?? ""] as const,
  },
  follows: {
    list: ["follows", "list"] as const,
  },
  live: {
    now: ["live", "now"] as const,
    channel: (url: string) => ["live", "channel", url] as const,
  },
  playlists: {
    all: ["playlists"] as const,
    list: ["playlists", "list"] as const,
    detail: (id: number) => ["playlists", "detail", id] as const,
    serverCopies: (id: number) => ["playlists", "server-copies", id] as const,
  },
  history: {
    all: ["history"] as const,
    stats: (range: string, youtube: boolean) =>
      ["history", "stats", range, youtube] as const,
  },
  takeout: {
    all: ["takeout"] as const,
    history: ["takeout", "history"] as const,
    rewatched: ["takeout", "rewatched"] as const,
  },
  notifications: ["notifications"] as const,
  trash: {
    all: ["trash"] as const,
    summary: ["trash", "summary"] as const,
    list: ["trash", "list"] as const,
  },
};
