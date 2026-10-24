import { describe, expect, it } from "vitest";
import {
  looksLikeRecoveryCode,
  recoveryCodesFileName,
  recoveryCodesText,
} from "./twoFactor";

describe("looksLikeRecoveryCode", () => {
  it("accepts the printed form, with or without the dash", () => {
    expect(looksLikeRecoveryCode("ABCDE-23456")).toBe(true);
    expect(looksLikeRecoveryCode(" abcde23456 ")).toBe(true);
  });
  it("does not take an authenticator code for one", () => {
    expect(looksLikeRecoveryCode("123456")).toBe(false);
    expect(looksLikeRecoveryCode("123 456")).toBe(false);
    expect(looksLikeRecoveryCode("")).toBe(false);
  });
});

describe("recoveryCodesText", () => {
  it("names the account and lists every code on its own line", () => {
    const text = recoveryCodesText(
      "jon",
      ["AAAAA-11111", "BBBBB-22222"],
      new Date("2026-10-23T12:00:00Z")
    );
    expect(text).toContain("recovery codes for jon");
    expect(text).toContain("Made 2026-10-23");
    expect(text.split("\n")).toContain("AAAAA-11111");
    expect(text.split("\n")).toContain("BBBBB-22222");
  });
});

describe("recoveryCodesFileName", () => {
  it("keeps the name safe for a file", () => {
    expect(recoveryCodesFileName("jon")).toBe("horde-recovery-codes-jon.txt");
    expect(recoveryCodesFileName("a/b c")).toBe(
      "horde-recovery-codes-a_b_c.txt"
    );
    expect(recoveryCodesFileName("")).toBe("horde-recovery-codes-account.txt");
  });
});
