import { describe, expect, it } from "vitest";
import type { Subscription } from "../../types";
import { sortSubscriptions, subscriptionMatches } from "./match";

const sub = (channel_url: string, channel_name: string | null) =>
  ({ channel_url, channel_name, following: true }) as Subscription;

const glaze = sub("https://youtube.com/@glazelab", "Glaze Lab");
const byId = sub("https://youtube.com/channel/UCabcDEF123", "Old Engines");

describe("subscriptionMatches", () => {
  it("matches part of a name, in any case", () => {
    expect(subscriptionMatches(glaze, "glaze")).toBe(true);
    expect(subscriptionMatches(glaze, "LAB")).toBe(true);
    expect(subscriptionMatches(glaze, "kiln")).toBe(false);
  });

  it("matches the start of an @handle", () => {
    expect(subscriptionMatches(glaze, "@glazel")).toBe(true);
    expect(subscriptionMatches(byId, "@glaze")).toBe(false);
  });

  it("matches a pasted link only when it is the same channel", () => {
    expect(
      subscriptionMatches(glaze, "https://www.youtube.com/@GlazeLab/videos")
    ).toBe(true);
    expect(subscriptionMatches(glaze, "https://www.youtube.com/@glaze")).toBe(
      false
    );
    expect(subscriptionMatches(byId, "youtube.com/channel/UCabcDEF123")).toBe(
      true
    );
  });

  it("treats a channel with no name by its handle", () => {
    expect(
      subscriptionMatches(sub("https://youtube.com/@kiln", null), "kil")
    ).toBe(true);
  });
});

describe("sortSubscriptions", () => {
  const subs = [
    {
      channel_url: "u1",
      channel_name: "beta",
      followed_at: "2026-01-02T00:00:00Z",
      video_count: 3,
      subscriber_count: null,
    },
    {
      channel_url: "u2",
      channel_name: "Alpha",
      followed_at: "2026-03-01T00:00:00Z",
      video_count: 0,
      subscriber_count: 500,
    },
    {
      channel_url: "u3",
      channel_name: "gamma",
      followed_at: null,
      video_count: 3,
      subscriber_count: 9000,
    },
  ];
  const names = (sort: Parameters<typeof sortSubscriptions>[1]) =>
    sortSubscriptions(subs, sort).map((s) => s.channel_name);
  it("orders by name, newest subscription, downloads or subscribers", () => {
    expect(names("name")).toEqual(["Alpha", "beta", "gamma"]);
    expect(names("recent")).toEqual(["Alpha", "beta", "gamma"]);
    // A tie falls back to the name.
    expect(names("videos")).toEqual(["beta", "gamma", "Alpha"]);
    // Unknown counts go last.
    expect(names("subscribers")).toEqual(["gamma", "Alpha", "beta"]);
  });
});
