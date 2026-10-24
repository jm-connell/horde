import { describe, expect, it } from "vitest";
import {
  formatProviderLine,
  formatSpendLine,
  ollamaIsUsed,
  providerKindLabel,
} from "./aiProviderUsage";

describe("ollamaIsUsed", () => {
  it("is true when chat or embeddings run on Ollama", () => {
    expect(ollamaIsUsed({ provider: "ollama" })).toBe(true);
    expect(
      ollamaIsUsed({ provider: "openrouter", embed_provider: "ollama" })
    ).toBe(true);
  });

  it("is false for hosted providers", () => {
    expect(
      ollamaIsUsed({ provider: "openrouter", embed_provider: "openrouter" })
    ).toBe(false);
    expect(ollamaIsUsed({ provider: "openai_compatible" })).toBe(false);
    expect(ollamaIsUsed({})).toBe(false);
  });
});

describe("formatProviderLine", () => {
  it("names the provider kind and chat model", () => {
    expect(
      formatProviderLine({
        provider: "openrouter",
        chat_model: "google/gemini-2.5-flash-lite",
      })
    ).toBe("OpenRouter · google/gemini-2.5-flash-lite");
    expect(formatProviderLine({ provider: "openai_compatible" })).toBe(
      "OpenAI-compatible"
    );
    expect(formatProviderLine({ provider: "" })).toBe("");
  });

  it("labels unknown kinds as nothing", () => {
    expect(providerKindLabel("something")).toBe("");
    expect(providerKindLabel(null)).toBe("");
  });
});

describe("formatSpendLine", () => {
  it("summarizes spend windows and call count", () => {
    expect(
      formatSpendLine({
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
      formatSpendLine({
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
    expect(formatSpendLine(null)).toBe("");
  });
});
