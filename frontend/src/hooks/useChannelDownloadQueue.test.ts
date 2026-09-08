import { describe, expect, it, vi } from "vitest";
import type { ChannelFeedEntry, DownloadJob } from "../types";
import {
  channelFeedItemDownloading,
  channelFeedItemInLibrary,
  confirmPendingOnLeave,
} from "./useChannelDownloadQueue";

function feedEntry(
  patch: Partial<ChannelFeedEntry> & { url: string }
): ChannelFeedEntry {
  return {
    id: null,
    title: "Video",
    duration: null,
    thumbnail_url: null,
    view_count: null,
    like_count: null,
    dislike_count: null,
    published_at: null,
    in_library: false,
    video_id: null,
    library_height_px: null,
    max_height: null,
    ...patch,
  };
}

function job(patch: Partial<DownloadJob> & { url: string }): DownloadJob {
  return {
    id: 1,
    quality_preset: "1080p",
    status: "queued",
    progress: 0,
    title: null,
    title_override: null,
    channel: null,
    channel_override: null,
    thumbnail_url: null,
    notes_pending: null,
    paused: false,
    error: null,
    video_id: null,
    file_size: null,
    created_at: "",
    ...patch,
  };
}

describe("confirmPendingOnLeave", () => {
  it("submits every pending download that is still counting down", () => {
    const submit = vi.fn();
    confirmPendingOnLeave(
      [
        { tempId: 1, submitting: false },
        { tempId: 2, submitting: false },
        { tempId: 3, submitting: false },
      ],
      submit
    );
    expect(submit.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it("skips items already submitting and does nothing when empty", () => {
    const submit = vi.fn();
    confirmPendingOnLeave(
      [
        { tempId: 1, submitting: true },
        { tempId: 2, submitting: false },
      ],
      submit
    );
    expect(submit.mock.calls.map((c) => c[0])).toEqual([2]);

    submit.mockClear();
    confirmPendingOnLeave([], submit);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("channel feed download button state", () => {
  const url = "https://youtube.com/watch?v=abcdefghijk";
  const entry = feedEntry({ url });

  it("does not treat a queued or in-progress download as already in the library", () => {
    expect(
      channelFeedItemInLibrary(entry, new Map(), [
        job({ url, status: "queued" }),
      ])
    ).toBe(false);
    expect(
      channelFeedItemInLibrary(entry, new Map(), [
        job({ url, status: "downloading" }),
      ])
    ).toBe(false);
    expect(
      channelFeedItemDownloading(
        entry,
        new Set(),
        new Set([url]),
        []
      )
    ).toBe(true);
    expect(
      channelFeedItemDownloading(entry, new Set([url]), new Set(), [])
    ).toBe(true);
    expect(
      channelFeedItemDownloading(entry, new Set(), new Set(), [
        job({ url, status: "downloading" }),
      ])
    ).toBe(true);
  });

  it("marks a video as in the library only after the job completes", () => {
    expect(
      channelFeedItemInLibrary(entry, new Map(), [
        job({ url, status: "completed", video_id: 42 }),
      ])
    ).toBe(true);
    expect(
      channelFeedItemInLibrary(feedEntry({ url, in_library: true }), new Map(), [])
    ).toBe(true);
    expect(channelFeedItemInLibrary(entry, new Map([[url, 7]]), [])).toBe(
      true
    );
  });

  it("does not keep downloading state for a finished or failed job", () => {
    expect(
      channelFeedItemDownloading(entry, new Set(), new Set(), [
        job({ url, status: "completed", video_id: 42 }),
      ])
    ).toBe(false);
    expect(
      channelFeedItemDownloading(entry, new Set(), new Set(), [
        job({ url, status: "error" }),
      ])
    ).toBe(false);
  });
});
