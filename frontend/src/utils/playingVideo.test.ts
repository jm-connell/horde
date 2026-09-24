import { describe, expect, it } from "vitest";
import type { Video } from "../types";
import { mergePlayingVideo } from "./playingVideo";

function video(
  partial: Partial<Video> & Pick<Video, "id" | "last_position_sec">,
): Video {
  return partial as Video;
}

describe("mergePlayingVideo", () => {
  it("keeps the in-memory resume point and takes refreshed metadata", () => {
    const current = video({
      id: 4,
      last_position_sec: 10,
      title: "Old",
      processing_sprites: true,
    });
    const update = video({
      id: 4,
      last_position_sec: 48,
      title: "New",
      processing_sprites: true,
    });

    const merged = mergePlayingVideo(current, update);

    expect(merged?.last_position_sec).toBe(10);
    expect(merged?.title).toBe("New");
    expect(merged?.processing_sprites).toBe(true);
  });

  it("ignores a refresh for a different video", () => {
    const current = video({ id: 4, last_position_sec: 10 });
    const update = video({ id: 9, last_position_sec: 3 });
    expect(mergePlayingVideo(current, update)).toBeNull();
  });
});