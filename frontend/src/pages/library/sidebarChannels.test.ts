import { describe, expect, it } from "vitest";
import type { ChannelStat, FollowedChannel } from "../../types";
import { withSubscribedChannels } from "./sidebarChannels";

const lib = (channel: string, channel_url: string | null): ChannelStat => ({
  channel,
  channel_url,
  count: 3,
});
const follow = (channel_url: string, channel_name: string | null) =>
  ({ channel_url, channel_name, source: "manual" }) as FollowedChannel;

describe("withSubscribedChannels", () => {
  it("adds subscribed channels with no downloads after the library's", () => {
    const channels = [lib("Zed", "https://www.youtube.com/@Zed")];
    const out = withSubscribedChannels(channels, [
      follow("https://youtube.com/@retrogamecorps", "Retro Game Corps"),
      follow("https://youtube.com/@abc", null),
    ]);
    expect(out.map((c) => [c.channel, c.count])).toEqual([
      ["Zed", 3],
      ["@abc", 0],
      ["Retro Game Corps", 0],
    ]);
    expect(out[2].channel_url).toBe("https://youtube.com/@retrogamecorps");
  });

  it("does not repeat a channel the library has, by URL or by name", () => {
    const channels = [
      lib("Zed", "https://www.youtube.com/@Zed/videos"),
      lib("Named Only", null),
    ];
    const out = withSubscribedChannels(channels, [
      follow("https://youtube.com/@zed", "Zed Official"),
      follow("https://youtube.com/@other", "named only"),
    ]);
    expect(out).toBe(channels);
  });
});
