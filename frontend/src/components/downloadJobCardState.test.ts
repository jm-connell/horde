import { describe, expect, it } from "vitest";
import {
  canChangeJobQuality,
  canEditDownloadJobNotes,
  canManageCompletedLibraryVideo,
  canRedownloadRemovedJob,
  collapseOverflowKeys,
  isLibraryVideoGone,
} from "./downloadJobCardState";

describe("isLibraryVideoGone", () => {
  it("is true for missing or replaced library videos", () => {
    expect(isLibraryVideoGone(false, true, false)).toBe(true);
    expect(isLibraryVideoGone(false, false, true)).toBe(true);
    expect(isLibraryVideoGone(false, true, true)).toBe(true);
  });

  it("is false for device jobs and intact library jobs", () => {
    expect(isLibraryVideoGone(false, false, false)).toBe(false);
    expect(isLibraryVideoGone(true, true, false)).toBe(false);
    expect(isLibraryVideoGone(true, false, true)).toBe(false);
  });
});

describe("canEditDownloadJobNotes", () => {
  it("allows notes on an in-progress library job", () => {
    expect(canEditDownloadJobNotes(false, false, false, false, false)).toBe(
      true
    );
  });

  it("blocks notes after the download completes", () => {
    expect(canEditDownloadJobNotes(false, false, false, false, true)).toBe(
      false
    );
  });

  it("blocks notes when the library video is gone", () => {
    expect(canEditDownloadJobNotes(false, false, false, true)).toBe(false);
  });

  it("blocks notes for device, failed, and cancelled jobs", () => {
    expect(canEditDownloadJobNotes(true, false, false, false)).toBe(false);
    expect(canEditDownloadJobNotes(false, true, false, false)).toBe(false);
    expect(canEditDownloadJobNotes(false, false, true, false)).toBe(false);
  });
});

describe("canManageCompletedLibraryVideo", () => {
  it("allows watch, delete, and playlist on a finished library video", () => {
    expect(canManageCompletedLibraryVideo(true, false, false, 12)).toBe(true);
  });

  it("hides those actions for device, missing, or in-progress jobs", () => {
    expect(canManageCompletedLibraryVideo(true, true, false, 12)).toBe(false);
    expect(canManageCompletedLibraryVideo(true, false, true, 12)).toBe(false);
    expect(canManageCompletedLibraryVideo(false, false, false, 12)).toBe(false);
    expect(canManageCompletedLibraryVideo(true, false, false, null)).toBe(
      false
    );
  });
});

describe("canRedownloadRemovedJob", () => {
  it("allows redownload only for completed deleted library videos", () => {
    expect(canRedownloadRemovedJob(true, false, false, true, false)).toBe(true);
  });

  it("hides redownload for replaced, failed, device, or in-progress jobs", () => {
    expect(canRedownloadRemovedJob(true, false, false, true, true)).toBe(false);
    expect(canRedownloadRemovedJob(true, false, true, true, false)).toBe(false);
    expect(canRedownloadRemovedJob(true, true, false, true, false)).toBe(false);
    expect(canRedownloadRemovedJob(false, false, false, true, false)).toBe(false);
    expect(canRedownloadRemovedJob(true, false, false, false, false)).toBe(false);
  });
});

describe("canChangeJobQuality", () => {
  it("allows changing resolution on queued and in-flight jobs", () => {
    expect(canChangeJobQuality("queued", false, false, false)).toBe(true);
    expect(canChangeJobQuality("downloading", false, false, false)).toBe(true);
    expect(canChangeJobQuality("processing", false, false, false)).toBe(true);
  });

  it("blocks changes on finished jobs", () => {
    expect(canChangeJobQuality("completed", false, false, true)).toBe(false);
    expect(canChangeJobQuality("error", true, false, false)).toBe(false);
    expect(canChangeJobQuality("cancelled", false, true, false)).toBe(false);
  });
});

describe("collapseOverflowKeys", () => {
  it("hides done, then res, then size, then playlist", () => {
    const optional = { done: 50, res: 50, size: 50, playlist: 50 };
    const fixed = [100];
    expect([...collapseOverflowKeys(300, 0, fixed, optional)]).toEqual([]);
    expect([...collapseOverflowKeys(250, 0, fixed, optional)]).toEqual([
      "done",
    ]);
    expect([...collapseOverflowKeys(200, 0, fixed, optional)]).toEqual([
      "done",
      "res",
    ]);
    expect([...collapseOverflowKeys(150, 0, fixed, optional)]).toEqual([
      "done",
      "res",
      "size",
    ]);
    expect([...collapseOverflowKeys(100, 0, fixed, optional)]).toEqual([
      "done",
      "res",
      "size",
      "playlist",
    ]);
  });
});
