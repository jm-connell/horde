import { describe, expect, it } from "vitest";
import type { Subscription } from "../../types";
import { subscriptionMatches } from "./match";

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
