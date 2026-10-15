import { describe, expect, it } from "vitest";
import { isQuotaError, quotaMessage, StorageQuotaError } from "./quota";

describe("isQuotaError", () => {
  it("recognises browser quota failures and our own pre-check", () => {
    expect(isQuotaError({ name: "QuotaExceededError" })).toBe(true);
    expect(isQuotaError({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
    expect(isQuotaError({ name: "Error", code: 22 })).toBe(true);
    expect(isQuotaError(new StorageQuotaError(2 * 1024 ** 3, 1024 ** 2))).toBe(
      true
    );
  });

  it("ignores everything else", () => {
    expect(isQuotaError(new Error("network"))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError("QuotaExceededError")).toBe(false);
  });
});

describe("quotaMessage", () => {
  it("includes remaining space when known", () => {
    expect(quotaMessage("Clip", 512 * 1024 ** 2)).toContain("512 MB");
    expect(quotaMessage("Clip", null)).not.toContain("free");
  });
});
