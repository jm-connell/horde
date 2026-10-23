import { describe, expect, it } from "vitest";
import { inputToLimit, limitToInput, limitUsage } from "./storageLimit";

const GB = 1024 ** 3;

describe("limitToInput", () => {
  it("shows no limit as an empty field", () => {
    expect(limitToInput(null)).toBe("");
    expect(limitToInput(undefined)).toBe("");
    expect(limitToInput(0)).toBe("");
  });
  it("shows whole gigabytes without a decimal point", () => {
    expect(limitToInput(55 * GB)).toBe("55");
  });
  it("keeps up to two decimals", () => {
    expect(limitToInput(2.5 * GB)).toBe("2.5");
    expect(limitToInput(1.3333 * GB)).toBe("1.33");
  });
});

describe("inputToLimit", () => {
  it("reads gigabytes as bytes", () => {
    expect(inputToLimit("55")).toBe(55 * GB);
    expect(inputToLimit(" 2.5 ")).toBe(2.5 * GB);
  });
  it("treats empty and zero as no limit", () => {
    expect(inputToLimit("")).toBeNull();
    expect(inputToLimit("  ")).toBeNull();
    expect(inputToLimit("0")).toBeNull();
  });
  it("rejects what is not a size", () => {
    expect(inputToLimit("abc")).toBeUndefined();
    expect(inputToLimit("-5")).toBeUndefined();
  });
});

describe("limitUsage", () => {
  it("is ok below 90 %", () => {
    expect(limitUsage(38.2 * GB, 55 * GB)).toEqual({
      percent: 69,
      level: "ok",
    });
  });
  it("warns from 90 %", () => {
    expect(limitUsage(49.5 * GB, 55 * GB).level).toBe("warn");
  });
  it("is full at the limit and caps the bar", () => {
    expect(limitUsage(60 * GB, 55 * GB)).toEqual({
      percent: 100,
      level: "full",
    });
  });
});
