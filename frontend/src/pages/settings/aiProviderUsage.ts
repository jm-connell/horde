import type { OpenRouterCosts } from "../../types";
import { formatUsdCost } from "../../utils";

const KIND_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama",
  openai_compatible: "OpenAI-compatible",
};

/** Display name of a provider kind from the status / connection test. */
export function providerKindLabel(kind?: string | null): string {
  return (kind && KIND_LABELS[kind]) || "";
}

type ProviderHints = {
  provider?: string | null;
  embed_provider?: string | null;
  chat_model?: string | null;
  reports_cost?: boolean;
};

/** Whether Horde sends work to an Ollama server (GPU sizing applies). */
export function ollamaIsUsed(s: ProviderHints): boolean {
  return s.provider === "ollama" || s.embed_provider === "ollama";
}

/** Provider kind and chat model for the compact System AI row. */
export function formatProviderLine(s: ProviderHints): string {
  const kind = providerKindLabel(s.provider);
  const model = (s.chat_model || "").trim();
  return [kind || null, model || null].filter(Boolean).join(" · ");
}

/** Spend snapshot: 24h, 7d (or weekly budget), and recent call count. */
export function formatSpendLine(
  costs: (Pick<OpenRouterCosts, "h24" | "d7"> & Partial<OpenRouterCosts>) | null
): string {
  if (!costs) return "";
  const h24 = formatUsdCost(costs.h24) || "$0";
  const d7 = formatUsdCost(costs.d7) || "$0";
  const parts = [`${h24} 24h`];
  if (costs.weekly_budget_usd != null) {
    const limit =
      formatUsdCost(costs.weekly_budget_usd) || `$${costs.weekly_budget_usd}`;
    parts.push(`${d7} / ${limit} week`);
  } else {
    parts.push(`${d7} 7d`);
  }
  const calls = costs.h24_calls ?? 0;
  if (calls > 0) {
    parts.push(`${calls} call${calls === 1 ? "" : "s"} 24h`);
  }
  return parts.join(" · ");
}
