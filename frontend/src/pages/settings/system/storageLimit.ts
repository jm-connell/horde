/** The library size limit: conversion between the GB the form shows and the bytes the API stores. */

const GB = 1024 ** 3;

/** Text for the input: whole numbers stay whole, fractions keep up to two decimals. */
export function limitToInput(bytes: number | null | undefined): string {
  if (!bytes) return "";
  return String(Math.round((bytes / GB) * 100) / 100);
}

/**
 * Bytes for what was typed: `null` is "no limit" (empty or 0), `undefined` is
 * something that is not a number, which the form puts back.
 */
export function inputToLimit(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const gb = Number(trimmed);
  if (!Number.isFinite(gb) || gb < 0) return undefined;
  if (gb === 0) return null;
  return Math.round(gb * GB);
}

export type LimitUsage = {
  /** 0–100, for the bar's width. */
  percent: number;
  /** "warn" from 90 %, "full" once the library has reached the limit. */
  level: "ok" | "warn" | "full";
};

export function limitUsage(used: number, limit: number): LimitUsage {
  const ratio = limit > 0 ? used / limit : 0;
  return {
    percent: Math.max(0, Math.min(100, Math.round(ratio * 100))),
    level: ratio >= 1 ? "full" : ratio >= 0.9 ? "warn" : "ok",
  };
}
