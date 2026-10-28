import { formatUsdCost } from "../../../utils";
import { INPUT_COMPACT } from "../constants";
import { useSettingsPage } from "../context";
import { Section, Toggle } from "../ui";
import { useAiPage } from "./aiPageContext";

/** Reported spend and the weekly budget (providers that report cost: OpenRouter). */
export default function CostsPane() {
  const { q, match } = useSettingsPage();
  const {
    appSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    openRouterCosts,
  } = useAiPage();
  if (!aiStatus?.reports_cost && !(openRouterCosts?.all_calls ?? 0))
    return null;

  return (
    <Section
      title="Costs"
      description="Spend the provider reports for Horde’s calls (summaries, chat, tags, embeddings). Only OpenRouter reports a cost per call."
      hidden={
        !!q &&
        !match(
          "cost",
          "costs",
          "usage",
          "billing",
          "openrouter",
          "spend",
          "budget",
          "limit",
          "threshold",
          "warn"
        )
      }
    >
      <div className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-5">
        {(
          [
            { key: "h24" as const, label: "24 hours" },
            { key: "d7" as const, label: "1 week" },
            { key: "d30" as const, label: "30 days" },
            { key: "y1" as const, label: "1 year" },
            { key: "all" as const, label: "All time" },
          ] as const
        ).map((row) => (
          <div
            key={row.key}
            className={`rounded-lg border bg-ink-950/60 px-3 py-2 ${
              row.key === "d7" && openRouterCosts?.over_budget
                ? "border-warning/40"
                : "border-ink-700"
            }`}
            title={aiDraft.chat_model || undefined}
          >
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
              {row.label}
            </p>
            <p
              className={`mt-1 text-sm font-medium tabular-nums ${
                row.key === "d7" && openRouterCosts?.over_budget
                  ? "text-warning"
                  : "text-gray-200"
              }`}
            >
              {formatUsdCost(openRouterCosts?.[row.key] ?? 0) || "$0"}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-2 max-w-2xl text-xs text-muted">
        Totals are recorded locally from the provider’s usage responses. They
        may differ slightly from its dashboard.
      </p>

      <div className="mt-4 max-w-2xl space-y-3 border-t border-ink-800 pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-gray-200">
              Warn if weekly spend exceeds
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-sm text-muted">$</span>
              <input
                type="number"
                min={0.01}
                max={100000}
                step={0.01}
                inputMode="decimal"
                value={aiDraft.weekly_budget_usd ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  setAiDraft((d) => ({
                    ...d,
                    weekly_budget_usd: raw === "" ? null : Number(raw),
                  }));
                }}
                onBlur={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === "") {
                    void saveAi({ weekly_budget_usd: null });
                    return;
                  }
                  const n = Number(raw);
                  if (!Number.isFinite(n) || n <= 0) {
                    setAiDraft((d) => ({
                      ...d,
                      weekly_budget_usd:
                        appSettings?.ai.weekly_budget_usd ?? null,
                    }));
                    return;
                  }
                  void saveAi({ weekly_budget_usd: n });
                }}
                placeholder="e.g. 1"
                aria-label="Weekly AI budget in USD"
                className={`${INPUT_COMPACT} w-28`}
              />
            </span>
          </label>
        </div>
        <p className="text-xs text-muted">
          Uses the rolling last 7 days total. Leave blank for no limit. You’ll
          get a toast and a banner when spend crosses this amount.
        </p>
        <div
          className={`flex max-w-2xl items-center gap-3 ${
            aiDraft.weekly_budget_usd == null ? "opacity-50" : ""
          }`}
        >
          <span className="text-sm font-medium text-gray-200">
            Stop AI calls when exceeded
          </span>
          <Toggle
            checked={aiDraft.budget_hard_limit}
            onChange={() => {
              if (aiDraft.weekly_budget_usd == null) return;
              saveAi({
                budget_hard_limit: !aiDraft.budget_hard_limit,
              });
            }}
          />
        </div>
        <p className="text-xs text-muted">
          When on, further AI calls are blocked and the AI queue pauses once the
          weekly budget is hit.
        </p>
        {openRouterCosts?.over_budget && aiDraft.weekly_budget_usd != null && (
          <div
            className={`rounded-lg border px-3 py-2 text-xs ${
              openRouterCosts.blocked
                ? "border-danger/35 bg-danger/10 text-danger"
                : "border-warning/30 bg-warning/10 text-warning"
            }`}
          >
            {openRouterCosts.blocked ? (
              <p>
                Weekly AI budget of{" "}
                {formatUsdCost(aiDraft.weekly_budget_usd) ||
                  `$${aiDraft.weekly_budget_usd}`}{" "}
                exceeded ({formatUsdCost(openRouterCosts.d7) || "$0"} in the
                last 7 days). AI calls are blocked and the AI queue was paused.
                Raise the limit, clear it, or turn off the hard stop — then
                resume the queue.
              </p>
            ) : (
              <p>
                Weekly AI spend is {formatUsdCost(openRouterCosts.d7) || "$0"}{" "}
                (limit{" "}
                {formatUsdCost(aiDraft.weekly_budget_usd) ||
                  `$${aiDraft.weekly_budget_usd}`}
                ). Turn on Stop AI calls when exceeded to block further calls.
              </p>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}
