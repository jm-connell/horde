import type { ChannelStat, FollowedChannel } from "../../types";
import { normalizeChannelUrl } from "../../utils/followUrl";

/** "@handle" of a channel URL, for a subscription saved without a name. */
function handleOf(url: string): string | null {
  return /\/(@[^/?#]+)/.exec(url)?.[1] ?? null;
}

/**
 * The sidebar's channels: those with downloads, then the channels the user is
 * subscribed to and has nothing from yet (count 0), by name. Without these a
 * channel someone subscribed to, or turned Ask on for, was nowhere on Home
 * until its first download.
 */
export function withSubscribedChannels(
  channels: ChannelStat[],
  follows: FollowedChannel[]
): ChannelStat[] {
  const names = new Set(channels.map((c) => c.channel.toLowerCase()));
  const urls = new Set(
    channels.map((c) => c.channel_url && normalizeChannelUrl(c.channel_url))
  );
  const extra: ChannelStat[] = [];
  for (const follow of follows) {
    const name = follow.channel_name?.trim() || handleOf(follow.channel_url);
    if (!name || names.has(name.toLowerCase())) continue;
    if (urls.has(normalizeChannelUrl(follow.channel_url))) continue;
    names.add(name.toLowerCase());
    extra.push({ channel: name, channel_url: follow.channel_url, count: 0 });
  }
  if (extra.length === 0) return channels;
  extra.sort((a, b) => a.channel.localeCompare(b.channel));
  return [...channels, ...extra];
}
