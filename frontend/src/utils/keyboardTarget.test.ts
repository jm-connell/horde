import { describe, expect, it } from "vitest";
import {
  isInteractiveControl,
  isTextEntryTarget,
  ownsArrowKeys,
} from "./keyboardTarget";

const el = (
  tagName: string,
  attrs: Record<string, string> = {},
  extra = {}
) => ({
  tagName,
  getAttribute: (name: string) => attrs[name] ?? null,
  closest: () => null,
  ...extra,
});

describe("isTextEntryTarget", () => {
  it("is true for text fields, textareas, selects and contenteditable", () => {
    expect(isTextEntryTarget(el("INPUT"))).toBe(true);
    expect(isTextEntryTarget(el("INPUT", { type: "search" }))).toBe(true);
    expect(isTextEntryTarget(el("TEXTAREA"))).toBe(true);
    expect(isTextEntryTarget(el("SELECT"))).toBe(true);
    expect(isTextEntryTarget(el("DIV", {}, { isContentEditable: true }))).toBe(
      true
    );
    expect(isTextEntryTarget(el("DIV", { contenteditable: "true" }))).toBe(
      true
    );
  });

  it("is false for sliders, checkboxes, buttons and plain elements", () => {
    expect(isTextEntryTarget(el("INPUT", { type: "range" }))).toBe(false);
    expect(isTextEntryTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTextEntryTarget(el("BUTTON"))).toBe(false);
    expect(isTextEntryTarget(el("DIV"))).toBe(false);
    expect(isTextEntryTarget(null)).toBe(false);
  });
});

describe("isInteractiveControl", () => {
  it("covers native controls and ARIA-role widgets", () => {
    expect(isInteractiveControl(el("BUTTON"))).toBe(true);
    expect(isInteractiveControl(el("A"))).toBe(true);
    expect(isInteractiveControl(el("DIV", {}, { closest: () => ({}) }))).toBe(
      true
    );
    expect(isInteractiveControl(el("DIV"))).toBe(false);
    expect(isInteractiveControl(el("VIDEO"))).toBe(false);
  });
});

describe("ownsArrowKeys", () => {
  it("is true for form fields and ARIA widgets that navigate with arrows", () => {
    expect(ownsArrowKeys(el("INPUT", { type: "range" }))).toBe(true);
    expect(ownsArrowKeys(el("SELECT"))).toBe(true);
    expect(ownsArrowKeys(el("DIV", {}, { closest: () => ({}) }))).toBe(true);
    expect(ownsArrowKeys(el("BUTTON"))).toBe(false);
    expect(ownsArrowKeys(el("VIDEO"))).toBe(false);
  });
});
