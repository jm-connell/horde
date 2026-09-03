import { describe, expect, it } from "vitest";
import {
  canEditDownloadJobNotes,
  canRedownloadRemovedJob,
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
  it("allows notes on an active or finished library job", () => {
    expect(canEditDownloadJobNotes(false, false, false, false)).toBe(true);
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
