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
