import { useState } from "react";
import { api } from "../../../api";
import ThemedSelect from "../../../components/ThemedSelect";
import Collapse from "../../../components/Collapse";
import HelpTip from "../../../components/HelpTip";
import { formatUsdCost } from "../../../utils";
import type { AiSettings } from "../../../types";
import { ollamaIsUsed } from "../aiOllamaUsage";
import { useSettingsPage } from "../context";
import { Section, SettingRow, Toggle } from "../ui";
import {
  CHAT_MODEL_OPTIONS,
  CHAT_MODEL_TIP,
  EMBED_MODEL_OPTIONS,
  EMBED_MODEL_TIP,
  INPUT,
  INPUT_COMPACT,
  INPUT_INLINE,
  INPUT_KEY,
  OPENROUTER_PRESETS,
  PANEL_BTN,
  VRAM_OVERRIDE_TIP,
  WORKLOAD_OPTIONS,
  WORKLOAD_TIP,
} from "../constants";

const OPTIONS_MUTED =
  "pointer-events-none select-none opacity-50";

export default function ProvidersPane() {
  const {
    q,
    match,
    showToast,
    appSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    refreshAiStatus,
    aiProviderPane,
    setAiProviderPane,
    aiTesting,
    setAiTesting,
    openRouterTesting,
    setOpenRouterTesting,
    openRouterKeyDraft,
    setOpenRouterKeyDraft,
    openRouterModels,
    setOpenRouterModels,
    openRouterEmbedModels,
    setOpenRouterEmbedModels,
    openRouterModelFilter,
    setOpenRouterModelFilter,
    openRouterCosts,
    embedCustom,
    setEmbedCustom,
    chatCustom,
    setChatCustom,
    advancedModelsOpen,
    setAdvancedModelsOpen,
    reindexPrompt,
    setReindexPrompt,
    runAiProcess,
    applyWorkload,
    saveModels,
  } = useSettingsPage();

  const [openRouterTestStatus, setOpenRouterTestStatus] = useState<
    "ok" | "fail" | null
  >(null);

  const localAiUnused =
    aiDraft.openrouter_enabled &&
    aiDraft.openrouter_api_key_set &&
    aiDraft.openrouter_scope === "all" &&
    !aiDraft.ollama_prefer_embeddings;
  const showOllamaGpu = ollamaIsUsed(aiDraft);

  return (
    <>
      <Section
        first
        title="General"
        description="Settings that apply whether you use Local AI, OpenRouter, or both."
        hidden={
          !!q &&
          !match("workload", "light", "normal", "heavy", "gpu", "general")
        }
      >
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
              Workload
              <HelpTip text={WORKLOAD_TIP} />
            </span>
            <div className="ui-panel flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
              {WORKLOAD_OPTIONS.map((opt) => {
                const locked =
                  Boolean(aiStatus?.profile_locked) &&
                  opt.value !== "light";
                const selected = aiDraft.workload_profile === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={locked}
                    onClick={() => void applyWorkload(opt.value)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                      selected
                        ? "bg-accent/15 text-accent"
                        : "text-gray-400 hover:text-gray-200"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {reindexPrompt && (
            <div className="ui-panel rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100/90">
              <p>{reindexPrompt}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={PANEL_BTN}
                  onClick={() => {
                    setReindexPrompt(null);
                    void runAiProcess("reindex_embeds");
                  }}
                >
                  Rebuild indexes
                </button>
                <button
                  type="button"
                  className={PANEL_BTN}
                  onClick={() => setReindexPrompt(null)}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
          {aiStatus?.profile_locked && aiStatus.lock_reason && (
            <p className="text-xs text-amber-400/90">
              {aiStatus.lock_reason}
            </p>
          )}
          {aiStatus?.workload_warning && (
            <p className="text-xs text-amber-400/90">
              {aiStatus.workload_warning}
            </p>
          )}
          {aiStatus && aiStatus.models_match_profile === false && (
            <p className="text-xs text-gray-500">
              Local AI models customized in Advanced — re-apply a workload to
              reset them for the Ollama GPU.
            </p>
          )}
        </div>
      </Section>

      <div className="mb-4 mt-6 flex max-w-md rounded-lg border border-ink-700 bg-ink-900 p-0.5">
        {(
          [
            { id: "local" as const, label: "Local AI" },
            { id: "openrouter" as const, label: "OpenRouter" },
          ] as const
        ).map((pane) => {
          const active = aiProviderPane === pane.id;
          return (
            <button
              key={pane.id}
              type="button"
              onClick={() => {
                setAiProviderPane(pane.id);
                try {
                  localStorage.setItem("horde.aiProviderPane", pane.id);
                } catch {
                  /* ignore */
                }
              }}
              className={
                active
                  ? "flex-1 rounded-md bg-ink-800 px-3 py-1.5 text-sm font-medium text-accent"
                  : "flex-1 rounded-md px-3 py-1.5 text-sm font-medium text-gray-400 hover:text-gray-200"
              }
            >
              {pane.label}
            </button>
          );
        })}
      </div>

      {aiProviderPane === "local" && (
        <>
          <Section
            first
            hidden={
              !match(
                "ollama",
                "connection",
                "enable ai",
                "base url",
                "queue",
                "indexed",
                "gpu",
                "vram"
              )
            }
          >
            <div className="space-y-4">
              {aiDraft.openrouter_enabled &&
                aiDraft.openrouter_api_key_set &&
                aiDraft.openrouter_scope === "all" &&
                !aiDraft.ollama_prefer_embeddings && (
                  <div className="max-w-2xl space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                    <p className="text-xs text-amber-200/90">
                      OpenRouter is handling all AI tasks including embeddings
                      (search, related, category invent). Local AI is optional
                      for fallback or override.
                    </p>
                    <label className="flex items-center gap-2 text-xs text-gray-300">
                      <Toggle
                        checked={aiDraft.ollama_prefer_embeddings}
                        onChange={() =>
                          saveAi({
                            ollama_prefer_embeddings: true,
                          })
                        }
                      />
                      Use Ollama for embeddings instead
                    </label>
                  </div>
                )}
              {aiDraft.openrouter_enabled &&
                aiDraft.openrouter_api_key_set &&
                aiDraft.openrouter_scope === "all" &&
                aiDraft.ollama_prefer_embeddings && (
                  <div className="max-w-2xl space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
                    <p className="text-xs text-emerald-200/90">
                      Override on: embeddings use Ollama; LLM tasks still use
                      OpenRouter when connected.
                    </p>
                    <button
                      type="button"
                      className="text-xs text-gray-400 underline-offset-2 hover:text-gray-200 hover:underline"
                      onClick={() =>
                        saveAi({ ollama_prefer_embeddings: false })
                      }
                    >
                      Let OpenRouter handle embeddings again
                    </button>
                  </div>
                )}
              <div
                className={
                  !!q && !match("enable ai", "features")
                    ? "hidden"
                    : "flex items-center gap-3"
                }
              >
                <span className="text-sm font-medium text-gray-200">
                  Enable Local AI (Ollama)
                </span>
                <Toggle
                  checked={aiDraft.enabled}
                  onChange={() => saveAi({ enabled: !aiDraft.enabled })}
                />
              </div>
              <div
                className={
                  localAiUnused
                    ? `space-y-4 ${OPTIONS_MUTED}`
                    : "space-y-4"
                }
                aria-disabled={localAiUnused || undefined}
              >
              <div
                className={
                  !!q && !match("ollama", "connection", "base url", "test")
                    ? "hidden"
                    : "space-y-1.5"
                }
              >
                <span className="block text-sm font-medium text-gray-200">
                  Ollama connection
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={aiDraft.base_url}
                    onChange={(e) =>
                      setAiDraft((d) => ({ ...d, base_url: e.target.value }))
                    }
                    onBlur={(e) =>
                      saveAi({ base_url: e.target.value.trim() })
                    }
                    placeholder="http://192.168.x.x:11434"
                    aria-label="Ollama base URL"
                    className={INPUT_INLINE}
                  />
                  <button
                    type="button"
                    disabled={aiTesting}
                    onClick={async () => {
                      setAiTesting(true);
                      const result = await api
                        .testAiConnection(aiDraft.base_url || undefined)
                        .catch(() => null);
                      setAiTesting(false);
                      if (!result) {
                        showToast("Connection test failed");
                        return;
                      }
                      showToast(
                        result.ok
                          ? `Connected${result.base_url ? ` at ${result.base_url}` : ""}`
                          : result.detail || "Unreachable"
                      );
                      if (result.ok) {
                        const featurePatch: Partial<AiSettings> = {};
                        if (!aiDraft.use_subtitles)
                          featurePatch.use_subtitles = true;
                        if (!aiDraft.enrich_tags)
                          featurePatch.enrich_tags = true;
                        if (!aiDraft.ai_summaries)
                          featurePatch.ai_summaries = true;
                        if (!aiDraft.ai_chat)
                          featurePatch.ai_chat = true;
                        if (!aiDraft.ai_duplicates)
                          featurePatch.ai_duplicates = true;
                        if (Object.keys(featurePatch).length > 0) {
                          await saveAi(featurePatch);
                        }
                      }
                      refreshAiStatus();
                    }}
                    className={PANEL_BTN}
                  >
                    {aiTesting ? "Testing…" : "Test connection"}
                  </button>
                  {aiStatus && (aiStatus.ready || aiStatus.reachable) && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {aiStatus.ready ? "Connected" : "Reachable"}
                    </span>
                  )}
                  {aiDraft.enabled &&
                    aiStatus &&
                    !aiStatus.reachable &&
                    !aiStatus.ready && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                        Unreachable
                        {(aiStatus.waiting_count ?? 0) > 0
                          ? ` · ${aiStatus.waiting_count} waiting`
                          : ""}
                      </span>
                    )}
                </div>
              </div>
              <p className="max-w-2xl text-xs text-gray-500">
                Point to your Ollama instance for embeddings and local LLM
                fallback. Leave the URL blank to attempt auto-discover (but don't count on it). AI processing is done on the Ollama machine, if separate from Horde host. Not required when OpenRouter Tasks is set to All (unless you override embeddings back to Ollama).
              </p>
              <div
                className={
                  !showOllamaGpu ||
                  (!!q && !match("vram", "gpu", "ollama"))
                    ? "hidden"
                    : "space-y-2"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-gray-200">
                    Ollama VRAM (GB)
                    <HelpTip text={VRAM_OVERRIDE_TIP} />
                  </span>
                  <input
                    type="number"
                    min={0.5}
                    max={256}
                    step={0.5}
                    inputMode="decimal"
                    value={aiDraft.vram_gb ?? ""}
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      setAiDraft((d) => ({
                        ...d,
                        vram_gb: raw === "" ? null : Number(raw),
                      }));
                    }}
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      if (raw === "") {
                        void saveAi({ vram_gb: null });
                        return;
                      }
                      const n = Number(raw);
                      if (!Number.isFinite(n) || n <= 0) {
                        setAiDraft((d) => ({
                          ...d,
                          vram_gb: appSettings?.ai.vram_gb ?? null,
                        }));
                        return;
                      }
                      void saveAi({ vram_gb: n });
                    }}
                    placeholder="Auto"
                    aria-label="Ollama VRAM in GB"
                    className={INPUT_COMPACT}
                  />
                </div>
                {aiStatus?.gpu_source === "override" && (
                  <p className="text-xs text-gray-500">
                    Using your Ollama VRAM override for model sizing.
                    Re-apply a workload after changing it.
                  </p>
                )}
              </div>
              </div>
            </div>
          </Section>

          <Section
            title="Advanced"
            hidden={
              !match(
                "models",
                "embedding",
                "chat model",
                "vram",
                "auto-pull",
                "gpu",
                "advanced"
              )
            }
          >
            <div
              className={localAiUnused ? OPTIONS_MUTED : undefined}
              aria-disabled={localAiUnused || undefined}
            >
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="min-w-0 text-xs text-gray-500">
                Optional overrides. Workload already picks models for the
                Ollama GPU.
              </p>
              <button
                type="button"
                onClick={() => setAdvancedModelsOpen((o) => !o)}
                className={`${PANEL_BTN} shrink-0`}
              >
                {advancedModelsOpen
                  ? "Hide model overrides"
                  : "Show model overrides"}
              </button>
            </div>
            <div className="mb-3 max-w-md">
              <SettingRow
                title="Auto-pull missing models"
                description="Ask Ollama to download configured models when they are missing."
                control={
                  <Toggle
                    checked={aiDraft.auto_pull_models}
                    onChange={() =>
                      saveAi({
                        auto_pull_models: !aiDraft.auto_pull_models,
                      })
                    }
                  />
                }
              />
            </div>
            <Collapse open={advancedModelsOpen || Boolean(q)}>
              <div className="max-w-md space-y-3 pb-1">
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
                    Embedding model
                    <HelpTip text={EMBED_MODEL_TIP} />
                  </span>
                  <ThemedSelect
                    aria-label="Embedding model"
                    value={embedCustom ? "__custom__" : aiDraft.embed_model}
                    options={EMBED_MODEL_OPTIONS}
                    onChange={(value) => {
                      if (value === "__custom__") {
                        setEmbedCustom(true);
                        return;
                      }
                      setEmbedCustom(false);
                      setAiDraft((d) => ({
                        ...d,
                        embed_model: value,
                      }));
                    }}
                    className="w-full max-w-md"
                    buttonClassName="w-full"
                  />
                  {embedCustom && (
                    <input
                      value={aiDraft.embed_model}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          embed_model: e.target.value,
                        }))
                      }
                      placeholder="Ollama model name"
                      className={`${INPUT} mt-2`}
                    />
                  )}
                </label>
                <label className="block">
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-gray-500">
                    Chat model (tags, categories, duplicates)
                    <HelpTip text={CHAT_MODEL_TIP} />
                  </span>
                  <ThemedSelect
                    aria-label="Chat model"
                    value={chatCustom ? "__custom__" : aiDraft.chat_model}
                    options={CHAT_MODEL_OPTIONS}
                    onChange={(value) => {
                      if (value === "__custom__") {
                        setChatCustom(true);
                        return;
                      }
                      setChatCustom(false);
                      setAiDraft((d) => ({
                        ...d,
                        chat_model: value,
                      }));
                    }}
                    className="w-full max-w-md"
                    buttonClassName="w-full"
                  />
                  {chatCustom && (
                    <input
                      value={aiDraft.chat_model}
                      onChange={(e) =>
                        setAiDraft((d) => ({
                          ...d,
                          chat_model: e.target.value,
                        }))
                      }
                      placeholder="Ollama model name"
                      className={`${INPUT} mt-2`}
                    />
                  )}
                </label>
                <button
                  type="button"
                  onClick={() => void saveModels()}
                  className={PANEL_BTN}
                >
                  Save models
                </button>
              </div>
            </Collapse>
            </div>
          </Section>
        </>
      )}

      {aiProviderPane === "openrouter" && (
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
              <p className="max-w-2xl text-xs text-gray-500">
                Optional cloud LLM for{" "}
                <span className="text-gray-400">
                  summaries, chat, tag enrichment, and duplicate
                  confirmation
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
                    Embeddings / search / related / invent vectors currently
                    use Ollama
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
                aria-disabled={
                  !aiDraft.openrouter_enabled || undefined
                }
              >
                  <div className="max-w-2xl space-y-2">
                    <span className="text-sm font-medium text-gray-200">
                      Tasks
                    </span>
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
                    <p className="text-xs text-gray-500">
                      {aiDraft.openrouter_scope === "all"
                        ? "All AI tasks go through OpenRouter (unless Local AI overrides embeddings)."
                        : "Only summaries, chat, tags, and duplicate confirmation use OpenRouter."}
                    </p>
                  </div>
                  <p className="max-w-2xl text-xs text-amber-500/90">
                    Titles, descriptions, captions, notes, and prompts
                    are sent to OpenRouter and the selected third-party model
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
                              .catch(() => null);
                            setOpenRouterTesting(false);
                            if (!result) {
                              setOpenRouterTestStatus("fail");
                              showToast("OpenRouter test failed");
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
                            if (result.ok) {
                              const models = await api
                                .getOpenRouterModels()
                                .catch(() => null);
                              if (models) {
                                setOpenRouterModels(models.models || []);
                                setOpenRouterEmbedModels(
                                  models.embedding_models || []
                                );
                              }
                            }
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
                        {aiStatus?.llm_backend === "openrouter" && (
                          <span className="text-xs text-gray-500">
                            LLM tasks use OpenRouter
                          </span>
                        )}
                      </div>
                    </div>
                    {aiDraft.openrouter_api_key_set && (
                      <button
                        type="button"
                        className="text-xs text-gray-500 underline-offset-2 hover:text-gray-300 hover:underline"
                        onClick={async () => {
                          await saveAi({ openrouter_api_key: "" });
                          setOpenRouterKeyDraft("");
                          setOpenRouterTestStatus(null);
                          showToast("OpenRouter API key cleared");
                        }}
                      >
                        Clear saved key
                      </button>
                    )}
                    <div className="max-w-md space-y-2">
                      <span className="text-sm font-medium text-gray-200">
                        Model
                      </span>
                      <div className="flex flex-wrap gap-2">
                        {OPENROUTER_PRESETS.map((preset) => {
                          const active =
                            aiDraft.openrouter_model === preset.model;
                          return (
                            <button
                              key={preset.id}
                              type="button"
                              onClick={() =>
                                saveAi({ openrouter_model: preset.model })
                              }
                              className={
                                active
                                  ? "rounded-lg border border-accent/60 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent"
                                  : "rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1 text-xs font-medium text-gray-300 hover:border-accent/40 hover:text-accent"
                              }
                            >
                              {preset.label}
                              <span className="ml-1.5 text-[10px] text-gray-500">
                                {preset.model}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      <input
                        value={openRouterModelFilter}
                        onChange={(e) =>
                          setOpenRouterModelFilter(e.target.value)
                        }
                        placeholder="Filter models…"
                        aria-label="Filter OpenRouter models"
                        className={`${INPUT_COMPACT} !w-44 max-w-[14rem]`}
                      />
                      <ThemedSelect
                        value={aiDraft.openrouter_model}
                        aria-label="OpenRouter model"
                        className="w-full max-w-md"
                        buttonClassName="w-full"
                        options={(() => {
                          const fq = openRouterModelFilter.trim().toLowerCase();
                          const filtered = openRouterModels.filter((m) => {
                            if (!fq) return true;
                            return (
                              m.id.toLowerCase().includes(fq) ||
                              m.name.toLowerCase().includes(fq)
                            );
                          });
                          const opts = filtered.map((m) => ({
                            value: m.id,
                            label:
                              m.name && m.name !== m.id
                                ? `${m.name} (${m.id})`
                                : m.id,
                          }));
                          if (
                            !opts.some((o) => o.value === aiDraft.openrouter_model)
                          ) {
                            opts.unshift({
                              value: aiDraft.openrouter_model,
                              label: aiDraft.openrouter_model,
                            });
                          }
                          return opts;
                        })()}
                        onChange={(value) =>
                          void saveAi({ openrouter_model: value })
                        }
                      />
                      <p className="text-xs text-gray-500">
                        Recommendations are pinned above; pick any OpenRouter
                        model from the list. Default is Budget (
                        {OPENROUTER_PRESETS[0].model}).
                      </p>
                    </div>
                    {aiDraft.openrouter_scope === "all" && (
                      <div className="max-w-md space-y-2">
                        <span className="text-sm font-medium text-gray-200">
                          Embedding model
                        </span>
                        <ThemedSelect
                          value={aiDraft.openrouter_embed_model}
                          aria-label="OpenRouter embedding model"
                          className="w-full max-w-md"
                          buttonClassName="w-full"
                          options={(() => {
                            const source = openRouterEmbedModels.length
                              ? openRouterEmbedModels
                              : [
                                  {
                                    id: aiDraft.openrouter_embed_model,
                                    name: aiDraft.openrouter_embed_model,
                                  },
                                ];
                            const opts = source.map((m) => ({
                              value: m.id,
                              label:
                                m.name && m.name !== m.id
                                  ? `${m.name} (${m.id})`
                                  : m.id,
                            }));
                            if (
                              !opts.some(
                                (o) => o.value === aiDraft.openrouter_embed_model
                              )
                            ) {
                              opts.unshift({
                                value: aiDraft.openrouter_embed_model,
                                label: aiDraft.openrouter_embed_model,
                              });
                            }
                            return opts;
                          })()}
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
                        <p className="text-xs text-gray-500">
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
                    <p className="max-w-2xl text-xs text-gray-500">
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
                  <p className="text-[10px] font-medium uppercase tracking-wider text-gray-500">
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
            <p className="mt-2 max-w-2xl text-xs text-gray-500">
              Totals are recorded locally from OpenRouter usage responses.
              They may differ slightly from the OpenRouter dashboard.
            </p>

            <div className="mt-4 max-w-2xl space-y-3 border-t border-ink-800 pt-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-gray-200">
                    Warn if weekly spend exceeds
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm text-gray-500">$</span>
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
              <p className="text-xs text-gray-500">
                Uses the rolling last 7 days total. Leave blank for no limit.
                You&apos;ll get a toast and a banner when spend crosses this
                amount.
              </p>
              <div
                className={`flex max-w-2xl items-center gap-3 ${
                  aiDraft.openrouter_weekly_budget_usd == null
                    ? "opacity-50"
                    : ""
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
              <p className="text-xs text-gray-500">
                When on, further OpenRouter calls are blocked and the AI queue
                pauses once the weekly budget is hit. Local Ollama is
                unaffected.
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
                        exceeded (
                        {formatUsdCost(openRouterCosts.d7) || "$0"} in the
                        last 7 days). OpenRouter calls are blocked and the AI
                        queue was paused. Raise the limit, clear it, or turn
                        off the hard stop — then resume the queue.
                      </p>
                    ) : (
                      <p>
                        Weekly OpenRouter spend is{" "}
                        {formatUsdCost(openRouterCosts.d7) || "$0"} (limit{" "}
                        {formatUsdCost(aiDraft.openrouter_weekly_budget_usd) ||
                          `$${aiDraft.openrouter_weekly_budget_usd}`}
                        ). Turn on Stop OpenRouter when exceeded to block
                        further calls.
                      </p>
                    )}
                  </div>
                )}
            </div>
          </Section>
        </>
      )}
    </>
  );
}
