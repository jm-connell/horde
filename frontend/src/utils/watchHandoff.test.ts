import { describe, expect, it } from "vitest";
import { shouldSuspendPlaybackForWatch } from "./watchHandoff";

describe("shouldSuspendPlaybackForWatch", () => {
  it("suspends when switching from one preview stream to another", () => {
    expect(
      shouldSuspendPlaybackForWatch({
        playingStreamUrl: "https://youtu.be/aaa",
        playingVideoId: null,
        nextStreamUrl: "https://youtu.be/bbb",
      })
    ).toBe(true);
  });

  it("does not suspend when expanding the same preview", () => {
    expect(
      shouldSuspendPlaybackForWatch({
        playingStreamUrl: "https://youtu.be/aaa",
        playingVideoId: null,
        nextStreamUrl: "https://youtu.be/aaa",
      })
    ).toBe(false);
  });

  it("suspends when opening a preview while a library video is playing", () => {
    expect(
      shouldSuspendPlaybackForWatch({
        playingStreamUrl: null,
        playingVideoId: 12,
        nextStreamUrl: "https://youtu.be/aaa",
      })
    ).toBe(true);
  });

  it("suspends when opening a library video while a preview is playing", () => {
    expect(
      shouldSuspendPlaybackForWatch({
        playingStreamUrl: "https://youtu.be/aaa",
        playingVideoId: null,
        nextVideoId: 12,
      })
    ).toBe(true);
  });

  it("does not suspend when nothing is playing yet", () => {
    expect(
      shouldSuspendPlaybackForWatch({
        playingStreamUrl: null,
        playingVideoId: null,
        nextStreamUrl: "https://youtu.be/aaa",
      })
    ).toBe(false);
  });
});
