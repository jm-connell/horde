import { describe, expect, it } from "vitest";
import {
  downloadErrorHint,
  downloadErrorLabel,
  downloadErrorToast,
  extractFailureCopy,
} from "./downloadErrors";

describe("downloadErrors", () => {
  it("labels and hints known kinds", () => {
    expect(downloadErrorLabel("bot")).toBe("Bot check");
    expect(downloadErrorLabel("cookies")).toBe("Age-restricted / private");
    expect(downloadErrorHint("pot")).toContain("bgutil-pot");
    expect(downloadErrorHint("cookies")).toMatch(/retries|signed-in|access/i);
    expect(downloadErrorLabel(null)).toBe("Failed");
    expect(downloadErrorHint("unknown")).toBeNull();
  });

  it("splits extract failure target from the message", () => {
    expect(
      extractFailureCopy({
        message: 'Gated. On: "Secret" · Channel',
        target: '"Secret" · Channel',
      })
    ).toEqual({
      target: '"Secret" · Channel',
      message: "Gated.",
    });
  });

  it("composes toast messages", () => {
    expect(downloadErrorToast("bot", "blocked")).toBe("Bot check: blocked");
    expect(downloadErrorToast("unknown", "raw msg")).toBe("raw msg");
    expect(downloadErrorToast(null, null)).toBe("Download failed");
    expect(downloadErrorToast("cancelled", "Cancelled")).toBe("Cancelled");
    expect(downloadErrorToast("cancelled", "Download failed: boom")).toBe(
      "Cancelled"
    );
  });
});
