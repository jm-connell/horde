import { describe, expect, it } from "vitest";
import { filterThemedSelectOptions } from "./ThemedSelect";

describe("filterThemedSelectOptions", () => {
  const options = [
    { value: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
    { value: "openai/gpt-4o-mini", label: "GPT-4o mini" },
    { value: "zzz/other", label: "Other" },
  ];

  it("returns all options when the query is empty", () => {
    expect(filterThemedSelectOptions(options, "  ")).toEqual(options);
  });

  it("matches label or value", () => {
    expect(
      filterThemedSelectOptions(options, "flash").map((o) => o.value)
    ).toEqual(["google/gemini-2.5-flash-lite"]);
    expect(
      filterThemedSelectOptions(options, "gpt-4o").map((o) => o.value)
    ).toEqual(["openai/gpt-4o-mini"]);
  });
});
