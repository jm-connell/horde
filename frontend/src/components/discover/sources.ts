import type { DiscoverItem } from "../../types";

export type Source = DiscoverItem["source"];

/**
 * Where a Recommended+ card comes from, in the theme's accent: a downloaded
 * video gets a solid accent outline, one from a channel the user follows or
 * has indexed a faded one, and one from a channel new to them none (the plain
 * card). The legend next to the home tabs spells them out.
 */
export const SOURCE: Record<
  Source,
  { label: string; outline: string | null; dot: string }
> = {
  library: {
    label: "Downloaded",
    outline: "border border-accent",
    dot: "bg-accent",
  },
  channels: {
    label: "From your channels",
    outline: "border border-accent/35",
    dot: "bg-accent/35",
  },
  new: {
    label: "New to you",
    outline: null,
    dot: "ring-1 ring-inset ring-muted",
  },
};
