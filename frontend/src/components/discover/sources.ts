import type { DiscoverItem } from "../../types";

export type Source = DiscoverItem["source"];

/**
 * Where a Recommended card comes from, in the theme's accent: a downloaded
 * video gets a solid accent outline, one from a channel the user follows or
 * has indexed a faded one, and one from a channel new to them none (the plain
 * card). The legend (SourceLegend) spells them out with a small card in the
 * same outline; the plain card's key takes the card's own `ink-700` hairline.
 */
export const SOURCE: Record<
  Source,
  { label: string; outline: string | null; swatch: string }
> = {
  library: {
    label: "Downloaded",
    outline: "border border-accent",
    swatch: "border border-accent",
  },
  channels: {
    label: "From your channels",
    outline: "border border-accent/35",
    swatch: "border border-accent/35",
  },
  new: {
    label: "New to you",
    outline: null,
    swatch: "border border-ink-700",
  },
};
