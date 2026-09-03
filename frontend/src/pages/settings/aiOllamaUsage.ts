import type { OpenRouterCosts } from "../../types";
import { formatUsdCost } from "../../utils";

type ProviderHints = {
  enabled?: boolean;
  embed_backend?: string | null;
  llm_backend?: string | null;
  openrouter_enabled?: boolean;
  openrouter_api_key_set?: boolean;
  openrouter_scope?: string | null;
  openrouter_model?: string | null;
  ollama_prefer_embeddings?: boolean;
};

/** Whether Horde is actually sending work to Ollama (vs OpenRouter-only). */
export function ollamaIsUsed(s: ProviderHints): boolean {
  if (s.embed_backend === "ollama" || s.llm_backend === "ollama") {
    return true;
  }
  const openRouterOwnsAll =
    Boolean(s.openrouter_enabled) &&
    Boolean(s.openrouter_api_key_set) &&
    s.openrouter_scope === "all" &&
    !s.ollama_prefer_embeddings;
  if (openRouterOwnsAll) return false;
  if (s.ollama_prefer_embeddings) return true;
  return s.enabled === true;
}

/** Whether OpenRouter is the active LLM and/or embed backend. */
export function openrouterIsUsed(s: ProviderHints): boolean {
  if (s.llm_backend === "openrouter" || s.embed_backend === "openrouter") {
    return true;
  }
  return Boolean(s.openrouter_enabled && s.openrouter_api_key_set);
}

/** Model + task scope for the compact System AI OpenRouter row. */
export function formatOpenRouterModelLine(s: ProviderHints): string {
  const model = (s.openrouter_model || "").trim();
  const scope = s.openrouter_scope === "all" ? "all tasks" : "LLM";
  return [model || null, scope].filter(Boolean).join(" · ");
}

/** Spend snapshot: 24h, 7d (or weekly budget), and recent call count. */
export function formatOpenRouterSpendLine(
  costs: OpenRouterCosts | null
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
