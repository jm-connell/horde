import { describeError } from "../../../apiErrors";
import { api } from "../../../api";
import ThemedSelect from "../../../components/ThemedSelect";
import Collapse from "../../../components/Collapse";
import HelpTip from "../../../components/HelpTip";
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
  PANEL_BTN,
  VRAM_OVERRIDE_TIP,
} from "../constants";
import { useAiPage } from "./aiPageContext";
import { OPTIONS_MUTED } from "./providerConstants";

export default function LocalProviderPane() {
  const { q, match, showToast, showError } = useSettingsPage();
  const {
    appSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    refreshAiStatus,
    aiTesting,
    setAiTesting,
    embedCustom,
    setEmbedCustom,
    chatCustom,
    setChatCustom,
    advancedModelsOpen,
    setAdvancedModelsOpen,
    saveModels,
  } = useAiPage();
  const localAiUnused =
    aiDraft.openrouter_enabled &&
    aiDraft.openrouter_api_key_set &&
    aiDraft.openrouter_scope === "all" &&
    !aiDraft.ollama_prefer_embeddings;
  const showOllamaGpu = ollamaIsUsed(aiDraft);

  return (
    <>
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
                    (search, related, category invent). Local AI is optional for
                    fallback or override.
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
                    onClick={() => saveAi({ ollama_prefer_embeddings: false })}
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
                label="Enable Local AI (Ollama)"
                checked={aiDraft.enabled}
                onChange={() => saveAi({ enabled: !aiDraft.enabled })}
              />
            </div>
            <div
              className={
                localAiUnused ? `space-y-4 ${OPTIONS_MUTED}` : "space-y-4"
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
                    onBlur={(e) => saveAi({ base_url: e.target.value.trim() })}
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
                        .catch((err) => {
                          showError(
                            `Connection test failed: ${describeError(err)}`
                          );
                          return null;
                        });
                      setAiTesting(false);
                      if (!result) return;
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
                        if (!aiDraft.ai_chapters)
                          featurePatch.ai_chapters = true;
                        if (!aiDraft.ai_chat) featurePatch.ai_chat = true;
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
              <p className="max-w-2xl text-xs text-muted">
                Point to your Ollama instance for embeddings and local LLM
                fallback. Leave the URL blank to attempt auto-discover (but
                don't count on it). AI processing is done on the Ollama machine,
                if separate from Horde host. Not required when OpenRouter Tasks
                is set to All (unless you override embeddings back to Ollama).
              </p>
              <div
                className={
                  !showOllamaGpu || (!!q && !match("vram", "gpu", "ollama"))
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
                  <p className="text-xs text-muted">
                    Using your Ollama VRAM override for model sizing. Re-apply a
                    workload after changing it.
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
              <p className="min-w-0 text-xs text-muted">
                Optional overrides. Workload already picks models for the Ollama
                GPU.
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
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-muted">
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
                  <span className="mb-1 flex items-center gap-1.5 text-xs text-muted">
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
    </>
  );
}
