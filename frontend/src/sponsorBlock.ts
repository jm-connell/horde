export type SponsorBlockCategory =
  | "sponsor"
  | "selfpromo"
  | "interaction"
  | "intro"
  | "outro"
  | "preview"
  | "filler"
  | "music_offtopic";

export type SponsorBlockSkipMode = "auto" | "prompt";

export type SponsorBlockCategoryMap = Record<SponsorBlockCategory, boolean>;

export interface SponsorBlockCategoryInfo {
  id: SponsorBlockCategory;
  label: string;
  group: "common" | "extra";
  description: string;
  keywords: string;
}

export const SPONSOR_BLOCK_CATEGORIES: readonly SponsorBlockCategoryInfo[] = [
  {
    id: "sponsor",
    label: "Sponsor",
    group: "common",
    description: "Paid promotions and ads",
    keywords: "sponsor ad ads advertising commercial paid promotion",
  },
  {
    id: "selfpromo",
    label: "Self-promo",
    group: "common",
    description: "Unpaid plugs for the creator’s own work, merch, or channels",
    keywords: "selfpromo self promo self-promotion merch plug",
  },
  {
    id: "interaction",
    label: "Interaction",
    group: "common",
    description: "Like / subscribe / follow reminders",
    keywords: "interaction like subscribe follow reminder socials",
  },
  {
    id: "intro",
    label: "Intro",
    group: "common",
    description: "Opening animation or recap before the video starts",
    keywords: "intro introduction opening animation",
  },
  {
    id: "outro",
    label: "Outro",
    group: "common",
    description: "End screens, credits, “watch next”",
    keywords: "outro end screen credits watch next ending",
  },
  {
    id: "preview",
    label: "Preview / recap",
    group: "extra",
    description:
      "Clips of this video or upcoming content used as a teaser or recap.",
    keywords: "preview recap teaser coming up highlight clip",
  },
  {
    id: "filler",
    label: "Filler / tangents",
    group: "extra",
    description:
      "Jokes, pauses, and off-topic asides. Community-submitted and often aggressive; off by default.",
    keywords: "filler tangent joke pause aside off-topic",
  },
  {
    id: "music_offtopic",
    label: "Non-music",
    group: "extra",
    description:
      "Spoken sections in music videos (talky intro/outro). Off by default.",
    keywords: "music offtopic non-music music video talking spoken",
  },
];

export const SPONSOR_BLOCK_COMMON_CATEGORIES = SPONSOR_BLOCK_CATEGORIES.filter(
  (c) => c.group === "common"
);

export const SPONSOR_BLOCK_EXTRA_CATEGORIES = SPONSOR_BLOCK_CATEGORIES.filter(
  (c) => c.group === "extra"
);

export const DEFAULT_SPONSOR_BLOCK_CATEGORIES: SponsorBlockCategoryMap = {
  sponsor: true,
  selfpromo: true,
  interaction: true,
  intro: true,
  outro: true,
  preview: false,
  filler: false,
  music_offtopic: false,
};

const CATEGORY_IDS = new Set<string>(
  SPONSOR_BLOCK_CATEGORIES.map((c) => c.id)
);

const LABEL_BY_ID = new Map(
  SPONSOR_BLOCK_CATEGORIES.map((c) => [c.id, c.label])
);

export const SPONSOR_BLOCK_SEARCH_KEYWORDS = [
  "sponsorblock",
  "sponsor",
  "skip",
  "ad",
  "ads",
  "advertising",
  "commercial",
  "youtube only",
  "youtube",
  "autoskip",
  "auto skip",
  "ask to skip",
  "prompt",
  ...SPONSOR_BLOCK_CATEGORIES.flatMap((c) => [c.id, c.label, c.keywords]),
].join(" ");

export const SPONSOR_BLOCK_EXTRA_SEARCH_KEYWORDS =
  SPONSOR_BLOCK_EXTRA_CATEGORIES.flatMap((c) => [
    c.id,
    c.label,
    c.keywords,
    c.description,
  ]).join(" ");

export function enabledSponsorBlockCategories(
  map: SponsorBlockCategoryMap
): SponsorBlockCategory[] {
  return SPONSOR_BLOCK_CATEGORIES.filter((c) => map[c.id]).map((c) => c.id);
}

export function sponsorBlockSegmentLabel(category: string): string {
  return LABEL_BY_ID.get(category as SponsorBlockCategory) ?? "Segment";
}

export function normalizeSponsorBlockSkipMode(
  value: unknown
): SponsorBlockSkipMode {
  return value === "prompt" ? "prompt" : "auto";
}

export function normalizeSponsorBlockCategories(
  value: unknown
): SponsorBlockCategoryMap {
  const out: SponsorBlockCategoryMap = { ...DEFAULT_SPONSOR_BLOCK_CATEGORIES };
  if (!value || typeof value !== "object") return out;
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (CATEGORY_IDS.has(key) && typeof enabled === "boolean") {
      out[key as SponsorBlockCategory] = enabled;
    }
  }
  return out;
}
