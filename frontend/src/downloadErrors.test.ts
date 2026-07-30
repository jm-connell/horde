import { describe, expect, it } from "vitest";
import {
  downloadErrorHint,
  downloadErrorLabel,
  downloadErrorToast,
} from "./downloadErrors";

describe("downloadErrors", () => {
  it("labels and hints known kinds", () => {
    expect(downloadErrorLabel("bot")).toBe("Bot check");
    expect(downloadErrorHint("pot")).toContain("bgutil-pot");
    expect(downloadErrorLabel(null)).toBe("Failed");
    expect(downloadErrorHint("unknown")).toBeNull();
  });

  it("composes toast messages", () => {
    expect(downloadErrorToast("bot", "blocked")).toBe("Bot check: blocked");
    expect(downloadErrorToast("unknown", "raw msg")).toBe("raw msg");
    expect(downloadErrorToast(null, null)).toBe("Download failed");
  });
});
