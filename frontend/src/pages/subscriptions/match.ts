import type { Subscription } from "../../types";
import { normalizeChannelUrl } from "../../utils/followUrl";

/**
 * Whether a subscription is what the add box holds: the same channel for a
 * pasted link, otherwise a name or @handle containing the text.
 */
export function subscriptionMatches(sub: Subscription, text: string): boolean {
  const url = normalizeChannelUrl(sub.channel_url) ?? sub.channel_url;
  if (/^(https?:\/\/|www\.|m\.youtube\.|youtube\.com\/)/i.test(text))
    return url === normalizeChannelUrl(text);
  const needle = text.toLowerCase().replace(/^@/, "");
  return (
    (sub.channel_name ?? "").toLowerCase().includes(needle) ||
    url.toLowerCase().includes(`@${needle}`)
  );
}

/** How the subscription cards can be ordered. */
export type SubscriptionSort = "name" | "recent" | "videos" | "subscribers";

export const SUBSCRIPTION_SORTS: { value: SubscriptionSort; label: string }[] =
  [
    { value: "name", label: "Name" },
    { value: "recent", label: "Recently subscribed" },
    { value: "videos", label: "Most downloaded" },
    { value: "subscribers", label: "Most subscribers" },
  ];

export function isSubscriptionSort(value: unknown): value is SubscriptionSort {
  return SUBSCRIPTION_SORTS.some((s) => s.value === value);
}

/** `subs` in `sort` order; ties (and unknowns, last) fall back to the name. */
export function sortSubscriptions<
  T extends {
    channel_name?: string | null;
    channel_url: string;
    followed_at?: string | null;
    video_count?: number;
    subscriber_count?: number | null;
  },
>(subs: T[], sort: SubscriptionSort): T[] {
  const name = (s: T) => (s.channel_name || s.channel_url).toLocaleLowerCase();
  const byName = (a: T, b: T) => name(a).localeCompare(name(b));
  const key = (s: T): number | null =>
    sort === "recent"
      ? s.followed_at
        ? Date.parse(s.followed_at)
        : null
      : sort === "videos"
        ? (s.video_count ?? 0)
        : sort === "subscribers"
          ? (s.subscriber_count ?? null)
          : null;
  if (sort === "name") return [...subs].sort(byName);
  return [...subs].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === kb) return byName(a, b);
    if (ka === null) return 1;
    if (kb === null) return -1;
    return kb - ka;
  });
}
