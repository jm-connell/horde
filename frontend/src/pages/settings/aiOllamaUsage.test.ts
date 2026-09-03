import { describe, expect, it } from "vitest";
import {
  formatOpenRouterModelLine,
  formatOpenRouterSpendLine,
  ollamaIsUsed,
  openrouterIsUsed,
} from "./aiOllamaUsage";

describe("ollamaIsUsed", () => {
  it("is true when a backend is Ollama", () => {
    expect(ollamaIsUsed({ embed_backend: "ollama", enabled: false })).toBe(
      true
    );
    expect(ollamaIsUsed({ llm_backend: "ollama" })).toBe(true);
  });

  it("is false when OpenRouter owns all tasks", () => {
    expect(
      ollamaIsUsed({
        enabled: true,
        embed_backend: "openrouter",
        llm_backend: "openrouter",
        openrouter_enabled: true,
        openrouter_api_key_set: true,
        openrouter_scope: "all",
        ollama_prefer_embeddings: false,
      })
    ).toBe(false);
  });

  it("is true when embeddings are forced back to Ollama", () => {
    expect(
      ollamaIsUsed({
        enabled: true,
        openrouter_enabled: true,
        openrouter_api_key_set: true,
        openrouter_scope: "all",
        ollama_prefer_embeddings: true,
      })
    ).toBe(true);
  });

  it("follows the local enable switch when backends are unset", () => {
    expect(ollamaIsUsed({ enabled: true })).toBe(true);
    expect(ollamaIsUsed({ enabled: false })).toBe(false);
  });
});

describe("openrouterIsUsed", () => {
  it("is true when a backend is OpenRouter", () => {
    expect(openrouterIsUsed({ llm_backend: "openrouter" })).toBe(true);
    expect(openrouterIsUsed({ embed_backend: "openrouter" })).toBe(true);
  });

  it("is true when OpenRouter is enabled with a key", () => {
    expect(
      openrouterIsUsed({
        openrouter_enabled: true,
        openrouter_api_key_set: true,
      })
    ).toBe(true);
  });

  it("is false when OpenRouter is off", () => {
    expect(openrouterIsUsed({ enabled: true, llm_backend: "ollama" })).toBe(
      false
    );
  });
});

describe("formatOpenRouterModelLine", () => {
  it("includes model and LLM vs all-tasks scope", () => {
    expect(
      formatOpenRouterModelLine({
        openrouter_model: "google/gemini-2.5-flash-lite",
        openrouter_scope: "specialized",
      })
    ).toBe("google/gemini-2.5-flash-lite · LLM");
    expect(
      formatOpenRouterModelLine({
        openrouter_model: "openai/gpt-4o-mini",
        openrouter_scope: "all",
      })
    ).toBe("openai/gpt-4o-mini · all tasks");
  });
});

describe("formatOpenRouterSpendLine", () => {
  it("summarizes spend windows and call count", () => {
    expect(
      formatOpenRouterSpendLine({
        h24: 0.012,
        d7: 0.08,
        d30: 0.2,
        y1: 1,
        all: 1,
        h24_calls: 3,
      })
    ).toBe("$0.012 24h · $0.080 7d · 3 calls 24h");
  });

  it("shows weekly budget when set", () => {
    expect(
      formatOpenRouterSpendLine({
        h24: 0.5,
        d7: 1.25,
        d30: 1.25,
        y1: 1.25,
        all: 1.25,
        weekly_budget_usd: 2,
      })
    ).toBe("$0.500 24h · $1.25 / $2.00 week");
  });

  it("is empty before costs load", () => {
    expect(formatOpenRouterSpendLine(null)).toBe("");
  });
});
