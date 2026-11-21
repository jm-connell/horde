import { describe, expect, it } from "vitest";
import {
  OPENROUTER_ASSISTANT_MODEL,
  OPENROUTER_PRESETS,
  OPENROUTER_RECOMMENDED_MODELS,
  assistantDefaultModel,
} from "./constants";
import { openRouterSelectOptions } from "./openRouterModels";

const models = [
  { id: "zzz/other", name: "Other" },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
];

describe("openRouterSelectOptions", () => {
  it("pins recommended models first without duplicating them below", () => {
    const opts = openRouterSelectOptions(models, models[0].id, "", {
      pinRecommended: true,
    });
    const ids = opts.map((o) => o.value);
    expect(ids.slice(0, 3)).toEqual([
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
      "openai/gpt-4o-mini",
    ]);
    expect(
      ids.filter((id) => id === "google/gemini-2.5-flash-lite")
    ).toHaveLength(1);
    expect(ids[ids.length - 1]).toBe("zzz/other");
    expect(opts[0].group).toBe("Recommended");
    expect(opts.find((o) => o.value === "zzz/other")?.group).toBe("All models");
  });

  it("keeps recommended matches at the top when filtering", () => {
    const opts = openRouterSelectOptions(models, "", "flash", {
      pinRecommended: true,
    });
    expect(opts.map((o) => o.value)).toEqual([
      "google/gemini-2.5-flash",
      "google/gemini-2.5-flash-lite",
    ]);
  });

  it("skips recommended ids missing from a loaded catalog", () => {
    const opts = openRouterSelectOptions(
      [{ id: "zzz/other", name: "Other" }],
      "zzz/other",
      "",
      { pinRecommended: true }
    );
    expect(opts.map((o) => o.value)).toEqual(["zzz/other"]);
    expect(opts[0].group).toBeUndefined();
  });

  it("does not pin recommended models unless asked", () => {
    const opts = openRouterSelectOptions(models, "zzz/other");
    expect(opts[0].value).toBe("zzz/other");
    expect(opts[0].group).toBeUndefined();
  });

  it("includes every recommended slug in the pin list", () => {
    expect(OPENROUTER_RECOMMENDED_MODELS).toHaveLength(9);
    // The default background model leads the list.
    expect(OPENROUTER_RECOMMENDED_MODELS[0]).toBe(OPENROUTER_PRESETS[0].model);
    expect(OPENROUTER_PRESETS[0].model).toBe("deepseek/deepseek-v4.1-flash");
    expect(OPENROUTER_RECOMMENDED_MODELS).toContain(
      "google/gemini-2.5-flash-lite"
    );
  });
});

describe("assistantDefaultModel", () => {
  it("keeps Ask on the stronger model for installs still on the former budget model", () => {
    expect(assistantDefaultModel(true, "google/gemini-2.5-flash-lite")).toBe(
      OPENROUTER_ASSISTANT_MODEL
    );
  });

  it("follows the background model otherwise", () => {
    expect(assistantDefaultModel(true, OPENROUTER_PRESETS[0].model)).toBe("");
    expect(assistantDefaultModel(true, "openai/gpt-5")).toBe("");
    expect(assistantDefaultModel(false, "google/gemini-2.5-flash-lite")).toBe(
      ""
    );
  });
});
