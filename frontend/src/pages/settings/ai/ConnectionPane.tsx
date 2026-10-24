import { useState } from "react";
import Collapse from "../../../components/Collapse";
import HelpTip from "../../../components/HelpTip";
import { useAiModels } from "../../../queries/status";
import type { AiSettings } from "../../../types";
import {
  CHAT_MODEL_TIP,
  EMBED_MODEL_TIP,
  INPUT_COMPACT,
  OPENROUTER_PRESETS,
  PANEL_BTN,
  VRAM_OVERRIDE_TIP,
} from "../constants";
import { useSettingsPage } from "../context";
import { openRouterPriceHint } from "../openRouterModels";
import { Section, SettingRow, Toggle } from "../ui";
import { useAiPage } from "./aiPageContext";
import { providerKindLabel } from "../aiProviderUsage";
import EndpointFields from "./EndpointFields";
import ModelField from "./ModelField";

/** One OpenAI-compatible connection for chat (and embeddings unless split). */
export default function ConnectionPane() {
  const { q, match } = useSettingsPage();
  const {
    appSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    applyWorkload,
    saveModels,
  } = useAiPage();
  const [splitOpen, setSplitOpen] = useState(false);
  const chatModels = useAiModels("chat", aiDraft.base_url).data;
  const embedUrl = aiDraft.embed_base_url || aiDraft.base_url;
  const embedModels = useAiModels("embed", embedUrl).data;
  const separateEmbed = splitOpen || Boolean(aiDraft.embed_base_url);
  const isOpenRouter = aiStatus?.provider === "openrouter";
  const usesOllama =
    aiStatus?.provider === "ollama" || aiStatus?.embed_provider === "ollama";
  const embedChoices = embedModels?.embedding_models?.length
    ? embedModels.embedding_models
    : (embedModels?.models ?? []);

  return (
    <>
      <Section
        title="Provider"
        description="Any service that speaks the OpenAI API: a cloud provider (OpenRouter, OpenAI, Gemini, Groq, …) or a server you run (Ollama, LM Studio, llama.cpp, vLLM)."
        hidden={
          !!q &&
          !match(
            "provider",
            "connection",
            "base url",
            "api key",
            "openrouter",
            "ollama",
            "openai",
            "enable ai",
            "test"
          )
        }
      >
        <div className="max-w-3xl space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-gray-200">Enable AI</span>
            <Toggle
              label="Enable AI"
              checked={aiDraft.enabled}
              onChange={() => saveAi({ enabled: !aiDraft.enabled })}
            />
            {aiStatus?.configured && aiStatus.reachable && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-400 ring-1 ring-emerald-500/30">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                Connected
                {providerKindLabel(aiStatus.provider)
                  ? ` · ${providerKindLabel(aiStatus.provider)}`
                  : ""}
              </span>
            )}
            {aiDraft.enabled && aiStatus?.configured && !aiStatus.reachable && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-medium text-amber-300 ring-1 ring-amber-500/30">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                Unreachable
                {(aiStatus.waiting_count ?? 0) > 0
                  ? ` · ${aiStatus.waiting_count} waiting`
                  : ""}
              </span>
            )}
          </div>
          <EndpointFields
            target="chat"
            savedUrl={aiDraft.base_url}
            keySet={aiDraft.api_key_set}
            keyMasked={aiDraft.api_key}
            onSave={async (url, key, preset) => {
              const patch: Partial<AiSettings> = { base_url: url };
              if (key !== null) patch.api_key = key;
              // A preset suggests models only where none is set yet.
              if (preset?.chat && !aiDraft.chat_model)
                patch.chat_model = preset.chat;
              if (preset?.embed && !aiDraft.embed_model)
                patch.embed_model = preset.embed;
              await saveAi(patch);
            }}
          />
          <p className="text-xs text-muted">
            Horde runs in Docker, so <code>localhost</code> there is the Horde
            container itself. For a server on the Docker host use{" "}
            <code>host.docker.internal</code>; for another PC use its LAN
            address (e.g. <code>http://192.168.1.50:11434</code>). A bare{" "}
            <code>http://host:port</code> gets <code>/v1</code> added. See{" "}
            <a
              className="underline underline-offset-2 hover:text-gray-300"
              href="/wiki/ops/ai-setup/"
              target="_blank"
              rel="noreferrer"
            >
              AI setup
            </a>
            .
          </p>
          <p className="text-xs text-amber-500/90">
            Titles, descriptions, captions, notes, and chat messages are sent to
            this provider. Use a server you run (such as Ollama) to keep them on
            your network.
          </p>
        </div>
      </Section>

      <Section
        title="Models"
        hidden={
          !!q &&
          !match(
            "models",
            "chat model",
            "embedding",
            "budget",
            "best",
            "search index",
            "costs"
          )
        }
      >
        <div className="max-w-3xl space-y-5">
          {isOpenRouter && (
            <div className="grid max-w-xl grid-cols-2 gap-2">
              {OPENROUTER_PRESETS.map((preset) => {
                const active = aiDraft.chat_model === preset.model;
                const price = openRouterPriceHint(
                  chatModels?.models?.find((m) => m.id === preset.model)
                );
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() =>
                      void saveModels({ chat_model: preset.model })
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
                      {preset.recommended ? (
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
          )}
          <ModelField
            label="Chat model"
            tip={CHAT_MODEL_TIP}
            value={aiDraft.chat_model}
            models={chatModels?.models ?? []}
            pinRecommended={isOpenRouter}
            placeholder="e.g. llama3.2:3b or google/gemini-2.5-flash-lite"
            onSave={(v) => void saveModels({ chat_model: v })}
          />
          {aiStatus?.configured &&
            aiStatus.reachable &&
            aiDraft.chat_model &&
            !aiStatus.chat_model_present && (
              <p className="text-xs text-amber-400/90">
                {usesOllama
                  ? aiStatus.pulling.includes(aiDraft.chat_model)
                    ? "Downloading this model on Ollama…"
                    : "This model is not installed on Ollama yet."
                  : "The provider did not accept this model."}
              </p>
            )}
          <ModelField
            label="Embedding model"
            tip={EMBED_MODEL_TIP}
            value={aiDraft.embed_model}
            models={embedChoices}
            placeholder="e.g. nomic-embed-text (empty = no search indexes)"
            onSave={(v) => void saveModels({ embed_model: v })}
          />
          {!aiDraft.embed_model && (
            <p className="max-w-xl text-xs text-muted">
              No embedding model: semantic search, related videos and category
              shelves are off. Some providers (Groq, DeepSeek, Anthropic) have
              no embeddings; use a second server for them below.
            </p>
          )}
          <div className="max-w-xl space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-200">
              <Toggle
                checked={separateEmbed}
                onChange={() => {
                  if (separateEmbed && aiDraft.embed_base_url) {
                    void saveAi({ embed_base_url: "", embed_api_key: "" });
                  }
                  setSplitOpen(!separateEmbed);
                }}
              />
              Use a different server for embeddings
            </label>
            <Collapse open={separateEmbed}>
              <div className="pt-1">
                <EndpointFields
                  target="embed"
                  savedUrl={aiDraft.embed_base_url}
                  keySet={aiDraft.embed_api_key_set}
                  keyMasked={aiDraft.embed_api_key}
                  onSave={async (url, key, preset) => {
                    const patch: Partial<AiSettings> = { embed_base_url: url };
                    if (key !== null) patch.embed_api_key = key;
                    if (preset?.embed && !aiDraft.embed_model)
                      patch.embed_model = preset.embed;
                    await saveAi(patch);
                  }}
                />
              </div>
            </Collapse>
          </div>
          {aiStatus?.reports_cost && (
            <SettingRow
              title="Show costs in Watch"
              description="Summary and chat replies show a small cost tag. Settings totals always track usage."
              control={
                <Toggle
                  checked={aiDraft.show_costs}
                  onChange={() => saveAi({ show_costs: !aiDraft.show_costs })}
                />
              }
            />
          )}
        </div>
      </Section>

      <Section
        title="Ollama"
        description="Ollama can download models for you and size them to its GPU."
        hidden={
          !usesOllama ||
          (!!q && !match("ollama", "vram", "gpu", "auto-pull", "download"))
        }
      >
        <div className="max-w-2xl space-y-3">
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => void applyWorkload(aiDraft.workload_profile)}
          >
            Download recommended models
          </button>
          <SettingRow
            title="Download missing models"
            description="Ask Ollama to download the chosen models when they are missing."
            control={
              <Toggle
                checked={aiDraft.auto_pull_models}
                onChange={() =>
                  saveAi({ auto_pull_models: !aiDraft.auto_pull_models })
                }
              />
            }
          />
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
        </div>
      </Section>
    </>
  );
}
