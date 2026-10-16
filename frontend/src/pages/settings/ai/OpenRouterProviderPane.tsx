import { describeError } from "../../../apiErrors";
import { api } from "../../../api";
import ThemedSelect from "../../../components/ThemedSelect";
import { useConfirm } from "../../../context/ConfirmContext";
import { formatUsdCost } from "../../../utils";
import { useSettingsPage } from "../context";
import {
  openRouterPriceHint,
  openRouterSelectOptions,
} from "../openRouterModels";
import { Section, Toggle } from "../ui";
import {
  INPUT_COMPACT,
  INPUT_KEY,
  OPENROUTER_PRESETS,
  PANEL_BTN,
} from "../constants";
import { useAiPage } from "./aiPageContext";
import { OPTIONS_MUTED } from "./providerConstants";

export default function OpenRouterProviderPane({
  openRouterTestStatus,
  setOpenRouterTestStatus,
}: {
  openRouterTestStatus: "ok" | "fail" | null;
  setOpenRouterTestStatus: (status: "ok" | "fail" | null) => void;
}) {
  const { q, match, showToast, showError } = useSettingsPage();
  const {
    appSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    refreshAiStatus,
    openRouterTesting,
    setOpenRouterTesting,
    openRouterKeyDraft,
    setOpenRouterKeyDraft,
    openRouterModels,
    openRouterEmbedModels,
    refreshOpenRouterModels,
    openRouterCosts,
    setReindexPrompt,
  } = useAiPage();
  const confirm = useConfirm();

  return (
    <>
      <>
        <Section
          first
          title="OpenRouter"
          hidden={
            !!q &&
            !match(
              "openrouter",
              "api key",
              "privacy",
              "cloud",
              "budget",
              "best",
              "cost",
              "usage"
            )
          }
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-gray-200">
                Enable OpenRouter
              </span>
              <Toggle
                checked={aiDraft.openrouter_enabled}
                onChange={() =>
                  saveAi({
                    openrouter_enabled: !aiDraft.openrouter_enabled,
                  })
                }
              />
            </div>
            <p className="max-w-2xl text-xs text-muted">
              Optional cloud LLM for{" "}
              <span className="text-gray-400">
                summaries, chat, tag enrichment, and duplicate confirmation
              </span>
              {aiDraft.openrouter_scope === "all"
                ? ", plus embeddings, hybrid search, related videos, and category invent."
                : ". Embeddings, hybrid search, related videos, and category invent still need Ollama (or switch Tasks to All)."}{" "}
              Works without a local GPU when OpenRouter is enabled.
            </p>
            {!aiDraft.openrouter_enabled && (
              <div className="max-w-2xl rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <p className="text-xs text-amber-200/90">
                  OpenRouter is disabled. Local AI (Ollama) handles AI tasks
                  when enabled. Turn OpenRouter on to use cloud models for
                  summaries, chat, and related features.
                </p>
              </div>
            )}
            {aiDraft.openrouter_enabled &&
              (aiDraft.openrouter_scope === "specialized" ||
                aiDraft.ollama_prefer_embeddings) && (
                <div className="max-w-2xl rounded-lg border border-ink-600 bg-ink-950/80 px-3 py-2 text-xs text-gray-400">
                  Embeddings / search / related / invent vectors currently use
                  Ollama
                  {aiDraft.ollama_prefer_embeddings
                    ? " (override on)."
                    : "."}{" "}
                  {aiDraft.openrouter_scope === "specialized"
                    ? "Choose All under Tasks to move them to OpenRouter."
                    : "Turn off the Local AI override to use OpenRouter for embeddings."}
                </div>
              )}
            <div
              className={
                !aiDraft.openrouter_enabled
                  ? `space-y-4 ${OPTIONS_MUTED}`
                  : "space-y-4"
              }
              aria-disabled={!aiDraft.openrouter_enabled || undefined}
            >
              <div className="max-w-2xl space-y-2">
                <span className="text-sm font-medium text-gray-200">Tasks</span>
                <div className="ui-panel flex max-w-md rounded-lg border border-ink-700 bg-ink-900 p-0.5">
                  {(
                    [
                      {
                        id: "specialized" as const,
                        label: "Specialized",
                        tip: "Summaries, chat, tags, duplicates",
                      },
                      {
                        id: "all" as const,
                        label: "All",
                        tip: "Also embeddings & invent",
                      },
                    ] as const
                  ).map((opt) => {
                    const active = aiDraft.openrouter_scope === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        title={opt.tip}
                        onClick={async () => {
                          const prev = aiDraft.openrouter_scope;
                          await saveAi({ openrouter_scope: opt.id });
                          if (prev !== "all" && opt.id === "all") {
                            setReindexPrompt(
                              "OpenRouter All uses a cloud embed model. Rebuild search indexes so vectors match?"
                            );
                          }
                        }}
                        className={
                          active
                            ? "flex-1 rounded-md bg-ink-800 px-3 py-1.5 text-xs font-medium text-accent"
                            : "flex-1 rounded-md px-3 py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200"
                        }
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                <p className="text-xs text-muted">
                  {aiDraft.openrouter_scope === "all"
                    ? "All AI tasks go through OpenRouter (unless Local AI overrides embeddings)."
                    : "Only summaries, chat, tags, and duplicate confirmation use OpenRouter."}
                </p>
              </div>
              <p className="max-w-2xl text-xs text-amber-500/90">
                Titles, descriptions, captions, notes, and prompts are sent to
                OpenRouter and the selected third-party model
                {aiDraft.openrouter_scope === "all"
                  ? " (including caption text used for embeddings)."
                  : "."}{" "}
                Disable OpenRouter to keep those tasks local for privacy.
              </p>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <span className="block text-sm font-medium text-gray-200">
                    API key
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      value={openRouterKeyDraft}
                      onChange={(e) => setOpenRouterKeyDraft(e.target.value)}
                      onBlur={async () => {
                        const trimmed = openRouterKeyDraft.trim();
                        if (!trimmed) return;
                        await saveAi({ openrouter_api_key: trimmed });
                        setOpenRouterKeyDraft("");
                        showToast("OpenRouter API key saved");
                      }}
                      placeholder={
                        aiDraft.openrouter_api_key_set
                          ? `Key saved (${aiDraft.openrouter_api_key || "••••"})`
                          : "sk-or-…"
                      }
                      aria-label="OpenRouter API key"
                      className={INPUT_KEY}
                    />
                    <button
                      type="button"
                      disabled={openRouterTesting}
                      onClick={async () => {
                        setOpenRouterTesting(true);
                        const result = await api
                          .testOpenRouterConnection(
                            openRouterKeyDraft.trim() || undefined
                          )
                          .catch((err) => {
                            showError(
                              `OpenRouter test failed: ${describeError(err)}`
                            );
                            return null;
                          });
                        setOpenRouterTesting(false);
                        if (!result) {
                          setOpenRouterTestStatus("fail");
                          return;
                        }
                        setOpenRouterTestStatus(result.ok ? "ok" : "fail");
                        showToast(
                          result.ok
                            ? result.detail || "Connected"
                            : result.detail || "Unreachable"
                        );
                        if (result.ok && openRouterKeyDraft.trim()) {
                          await saveAi({
                            openrouter_api_key: openRouterKeyDraft.trim(),
                          });
                          setOpenRouterKeyDraft("");
                        }
                        if (result.ok) await refreshOpenRouterModels();
                        refreshAiStatus();
                      }}
                      className={PANEL_BTN}
                    >
                      {openRouterTesting ? "Testing…" : "Test OpenRouter"}
                    </button>
                    {(openRouterTestStatus === "ok" ||
                      (openRouterTestStatus !== "fail" &&
                        aiStatus?.openrouter_reachable)) && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                        Connected
                      </span>
                    )}
                    {openRouterTestStatus === "fail" && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                        Unreachable
                      </span>
                    )}
                  </div>
                </div>
                {aiDraft.openrouter_api_key_set && (
                  <button
                    type="button"
                    className="text-xs text-muted underline-offset-2 hover:text-gray-300 hover:underline"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Clear saved OpenRouter key?",
                        body: "OpenRouter only shows a key once. After you clear it here, you'll need a new key from OpenRouter to reconnect.",
                        confirmLabel: "Clear key",
                        danger: true,
                      });
                      if (!ok) return;
                      await saveAi({ openrouter_api_key: "" });
                      setOpenRouterKeyDraft("");
                      setOpenRouterTestStatus(null);
                      showToast("OpenRouter API key cleared");
                    }}
                  >
                    Clear saved key
                  </button>
                )}
                <div className="max-w-xl space-y-4">
                  <div className="space-y-2">
                    <span className="text-sm font-medium text-gray-200">
                      Chat model
                    </span>
                    <div className="grid grid-cols-2 gap-2">
                      {OPENROUTER_PRESETS.map((preset) => {
                        const active =
                          aiDraft.openrouter_model === preset.model;
                        const price = openRouterPriceHint(
                          openRouterModels.find((m) => m.id === preset.model)
                        );
                        const recommended = preset.recommended;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() =>
                              saveAi({ openrouter_model: preset.model })
                            }
                            className={
                              active
                                ? "rounded-lg border border-accent/60 bg-accent/10 px-3 py-2.5 text-left"
                                : "rounded-lg border border-ink-700 bg-ink-950 px-3 py-2.5 text-left hover:border-accent/40"
                            }
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className={`text-sm font-medium ${
                                  active ? "text-accent" : "text-gray-200"
                                }`}
                              >
                                {preset.label}
                              </span>
                              {recommended ? (
                                <span className="rounded-full px-1.5 py-px text-[10px] font-medium tracking-wide text-muted ring-1 ring-ink-600">
                                  Recommended
                                </span>
                              ) : null}
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-muted">
                              {preset.model}
                            </span>
                            {price ? (
                              <span
                                className="mt-0.5 block text-[11px] tabular-nums text-muted"
                                title="USD per 1M tokens"
                              >
                                {price}
                              </span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <ThemedSelect
                      value={aiDraft.openrouter_model}
                      aria-label="OpenRouter model"
                      className="w-full max-w-xl"
                      buttonClassName="w-full"
                      listClassName="max-h-80"
                      searchable
                      searchPlaceholder="Search models…"
                      options={openRouterSelectOptions(
                        openRouterModels,
                        aiDraft.openrouter_model,
                        "",
                        { pinRecommended: true }
                      )}
                      onChange={(value) =>
                        void saveAi({ openrouter_model: value })
                      }
                    />
                    <p className="text-xs text-muted">
                      Text chat models only. Type to search. Prices are USD per
                      1M input / output tokens.
                    </p>
                  </div>
                </div>
                {aiDraft.openrouter_scope === "all" && (
                  <div className="max-w-xl space-y-2">
                    <span className="text-sm font-medium text-gray-200">
                      Embedding model
                    </span>
                    <ThemedSelect
                      value={aiDraft.openrouter_embed_model}
                      aria-label="OpenRouter embedding model"
                      className="w-full max-w-xl"
                      buttonClassName="w-full"
                      options={openRouterSelectOptions(
                        openRouterEmbedModels.length
                          ? openRouterEmbedModels
                          : [
                              {
                                id: aiDraft.openrouter_embed_model,
                                name: aiDraft.openrouter_embed_model,
                              },
                            ],
                        aiDraft.openrouter_embed_model
                      )}
                      onChange={async (next) => {
                        const prev = aiDraft.openrouter_embed_model;
                        await saveAi({ openrouter_embed_model: next });
                        if (next !== prev) {
                          setReindexPrompt(
                            "Embedding model changed. Rebuild search indexes so vectors match the new model?"
                          );
                        }
                      }}
                    />
                    <p className="text-xs text-muted">
                      Used for search indexes, related videos, and category
                      shelves when Tasks is All. Changing this requires a
                      reindex.
                    </p>
                  </div>
                )}
                <div className="flex max-w-2xl items-center gap-3 pt-1">
                  <span className="text-sm font-medium text-gray-200">
                    Show costs in Watch
                  </span>
                  <Toggle
                    checked={aiDraft.openrouter_show_costs}
                    onChange={() =>
                      saveAi({
                        openrouter_show_costs: !aiDraft.openrouter_show_costs,
                      })
                    }
                  />
                </div>
                <p className="max-w-2xl text-xs text-muted">
                  When on, summary and chat replies show a subtle OpenRouter
                  cost tag. Settings totals below always track usage.
                </p>
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="OpenRouter costs"
          description="Usage attributed to Horde (summaries, chat, tags, embeds when routed to OpenRouter)."
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
                    ? "border-amber-500/40"
                    : "border-ink-700"
                }`}
                title={
                  aiDraft.openrouter_model
                    ? aiDraft.openrouter_model
                    : undefined
                }
              >
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted">
                  {row.label}
                </p>
                <p
                  className={`mt-1 text-sm font-medium tabular-nums ${
                    row.key === "d7" && openRouterCosts?.over_budget
                      ? "text-amber-200"
                      : "text-gray-200"
                  }`}
                >
                  {formatUsdCost(openRouterCosts?.[row.key] ?? 0) || "$0"}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 max-w-2xl text-xs text-muted">
            Totals are recorded locally from OpenRouter usage responses. They
            may differ slightly from the OpenRouter dashboard.
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
                    value={aiDraft.openrouter_weekly_budget_usd ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      setAiDraft((d) => ({
                        ...d,
                        openrouter_weekly_budget_usd:
                          raw === "" ? null : Number(raw),
                      }));
                    }}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === "") {
                        void saveAi({ openrouter_weekly_budget_usd: null });
                        return;
                      }
                      const n = Number(raw);
                      if (!Number.isFinite(n) || n <= 0) {
                        setAiDraft((d) => ({
                          ...d,
                          openrouter_weekly_budget_usd:
                            appSettings?.ai.openrouter_weekly_budget_usd ??
                            null,
                        }));
                        return;
                      }
                      void saveAi({ openrouter_weekly_budget_usd: n });
                    }}
                    placeholder="e.g. 1"
                    aria-label="Weekly OpenRouter budget in USD"
                    className={`${INPUT_COMPACT} w-28`}
                  />
                </span>
              </label>
            </div>
            <p className="text-xs text-muted">
              Uses the rolling last 7 days total. Leave blank for no limit.
              You&apos;ll get a toast and a banner when spend crosses this
              amount.
            </p>
            <div
              className={`flex max-w-2xl items-center gap-3 ${
                aiDraft.openrouter_weekly_budget_usd == null ? "opacity-50" : ""
              }`}
            >
              <span className="text-sm font-medium text-gray-200">
                Stop OpenRouter when exceeded
              </span>
              <Toggle
                checked={aiDraft.openrouter_budget_hard_limit}
                onChange={() => {
                  if (aiDraft.openrouter_weekly_budget_usd == null) return;
                  saveAi({
                    openrouter_budget_hard_limit:
                      !aiDraft.openrouter_budget_hard_limit,
                  });
                }}
              />
            </div>
            <p className="text-xs text-muted">
              When on, further OpenRouter calls are blocked and the AI queue
              pauses once the weekly budget is hit. Local Ollama is unaffected.
            </p>
            {openRouterCosts?.over_budget &&
              aiDraft.openrouter_weekly_budget_usd != null && (
                <div
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    openRouterCosts.blocked
                      ? "border-red-500/35 bg-red-500/10 text-red-100/90"
                      : "border-amber-500/30 bg-amber-500/10 text-amber-100/90"
                  }`}
                >
                  {openRouterCosts.blocked ? (
                    <p>
                      Weekly OpenRouter budget of{" "}
                      {formatUsdCost(aiDraft.openrouter_weekly_budget_usd) ||
                        `$${aiDraft.openrouter_weekly_budget_usd}`}{" "}
                      exceeded ({formatUsdCost(openRouterCosts.d7) || "$0"} in
                      the last 7 days). OpenRouter calls are blocked and the AI
                      queue was paused. Raise the limit, clear it, or turn off
                      the hard stop — then resume the queue.
                    </p>
                  ) : (
                    <p>
                      Weekly OpenRouter spend is{" "}
                      {formatUsdCost(openRouterCosts.d7) || "$0"} (limit{" "}
                      {formatUsdCost(aiDraft.openrouter_weekly_budget_usd) ||
                        `$${aiDraft.openrouter_weekly_budget_usd}`}
                      ). Turn on Stop OpenRouter when exceeded to block further
                      calls.
                    </p>
                  )}
                </div>
              )}
          </div>
        </Section>
      </>
    </>
  );
}
