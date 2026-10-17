import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api";
import { appSettingsQuery } from "../../../queries/app";
import { useOpenRouterModels } from "../../../queries/status";
import { queryKeys } from "../../../queries/keys";
import { setItem } from "../../../storage";
import type { AiWorkloadProfile } from "../../../types";
import { DEFAULT_AI } from "../constants";
import { useSettingsPage } from "../context";
import { firstMatchingAiPane } from "../search";
import type { AiPaneState } from "./useAiPaneState";
import type { AiCore } from "./useAiCore";

/** State of the AI tab's panes (Providers, Features, Jobs) on top of the shared AI core. */
export function useAiPanes(core: AiCore, paneState: AiPaneState) {
  const {
    aiPane,
    setAiPane,
    aiProviderPane,
    setAiProviderPane,
    providerPaneFromBackendRef: aiProviderPaneFromBackendRef,
  } = paneState;
  const { q, showToast } = useSettingsPage();
  const queryClient = useQueryClient();
  const {
    appSettings,
    setAppSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    refreshAiStatus,
  } = core;
  const [aiTesting, setAiTesting] = useState(false);
  const [openRouterTesting, setOpenRouterTesting] = useState(false);
  const [openRouterKeyDraft, setOpenRouterKeyDraft] = useState("");
  const [advancedModelsOpen, setAdvancedModelsOpen] = useState(false);
  const [reindexPrompt, setReindexPrompt] = useState<string | null>(null);
  const [catchUpScope, setCatchUpScope] = useState<"all_recent" | "all_full">(
    "all_recent"
  );
  const [individualStepsOpen, setIndividualStepsOpen] = useState(false);

  const openRouterModelsEnabled =
    !!aiDraft.openrouter_enabled && !!aiDraft.openrouter_api_key_set;
  const openRouterModelsQuery = useOpenRouterModels(openRouterModelsEnabled);
  const refreshOpenRouterModels = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.ai.models });
  const openRouterModels = openRouterModelsEnabled
    ? (openRouterModelsQuery.data?.models ?? [])
    : [];
  const openRouterEmbedModels = openRouterModelsEnabled
    ? (openRouterModelsQuery.data?.embedding_models ?? [])
    : [];

  useEffect(() => {
    if (!appSettings?.ai || aiProviderPaneFromBackendRef.current) return;
    if (q) return;
    aiProviderPaneFromBackendRef.current = true;
    const orInUse =
      !!appSettings.ai.openrouter_enabled &&
      !!appSettings.ai.openrouter_api_key_set;
    setAiProviderPane(orInUse ? "openrouter" : "local");
  }, [appSettings, q, aiProviderPaneFromBackendRef, setAiProviderPane]);

  // Search auto-switch: AI pane + Local/OpenRouter within Providers.
  useEffect(() => {
    if (!q) return;
    const pane = firstMatchingAiPane(q);
    if (pane && pane !== aiPane) {
      setAiPane(pane);
      setItem("horde.aiPane", pane);
    }
    const qq = q.toLowerCase();
    if (
      qq.includes("openrouter") ||
      qq.includes("api key") ||
      qq.includes("budget") ||
      qq.includes("cost") ||
      qq.includes("usage") ||
      qq.includes("cloud llm")
    ) {
      setAiProviderPane("openrouter");
    } else if (
      qq.includes("ollama") ||
      qq.includes("vram") ||
      qq.includes("workload")
    ) {
      setAiProviderPane("local");
    }
  }, [q, aiPane, setAiPane, setAiProviderPane]);

  const applyWorkload = async (profile: AiWorkloadProfile) => {
    try {
      const result = await api.applyAiWorkload(profile);
      const updated = await queryClient
        .fetchQuery({ ...appSettingsQuery(), staleTime: 0 })
        .catch(() => null);
      if (updated?.ai) {
        setAppSettings(updated);
        setAiDraft({ ...DEFAULT_AI, ...updated.ai });
      }
      showToast(result.detail || `Applied ${profile} workload`);
      refreshAiStatus();
      if (result.embed_model_changed) {
        setReindexPrompt(
          "Embedding model changed with this workload. Rebuild search indexes so semantic search and categories use the new model? Categories refresh automatically when indexing finishes."
        );
      } else {
        setReindexPrompt(null);
      }
    } catch (err) {
      showToast(
        err instanceof Error && err.message
          ? err.message
          : "Could not apply workload"
      );
    }
  };

  const saveModels = async () => {
    const embed = aiDraft.embed_model.trim();
    const chat = aiDraft.chat_model.trim();
    const prevEmbed = (
      appSettings?.ai.embed_model || DEFAULT_AI.embed_model
    ).trim();
    const embedChanged = embed !== prevEmbed;
    await saveAi({
      embed_model: embed,
      chat_model: chat,
    });
    if (embedChanged) {
      setReindexPrompt(
        "Embedding model changed. Rebuild search indexes so semantic search, related videos, and category shelves use the new model? Categories refresh automatically when indexing finishes."
      );
      refreshAiStatus();
      return;
    }
    setReindexPrompt(null);
    showToast("Models saved");
    refreshAiStatus();
  };

  return {
    aiProviderPane,
    setAiProviderPane,
    aiTesting,
    setAiTesting,
    openRouterTesting,
    setOpenRouterTesting,
    openRouterKeyDraft,
    setOpenRouterKeyDraft,
    openRouterModels,
    openRouterEmbedModels,
    refreshOpenRouterModels,
    advancedModelsOpen,
    setAdvancedModelsOpen,
    reindexPrompt,
    setReindexPrompt,
    applyWorkload,
    saveModels,
    catchUpScope,
    setCatchUpScope,
    individualStepsOpen,
    setIndividualStepsOpen,
  };
}
