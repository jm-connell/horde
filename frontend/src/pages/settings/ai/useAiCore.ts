import { useEffect, useState } from "react";
import { describeError } from "../../../apiErrors";
import { api } from "../../../api";
import { useUpdateAppSettings } from "../../../queries/app";
import {
  dataOrNull,
  useAiStatus,
  useOpenRouterCosts,
  useSystemStats,
} from "../../../queries/status";
import { getItem, setItem } from "../../../storage";
import { formatUsdCost } from "../../../utils";
import type { AiSettings } from "../../../types";
import {
  CHAT_MODEL_OPTIONS,
  DEFAULT_AI,
  EMBED_MODEL_OPTIONS,
} from "../constants";
import { useSettingsPage } from "../context";
import type { AiProcessAction } from "../types";
import { useLoadedAppSettings } from "../useLoadedAppSettings";

/**
 * What the AI tab and the System tab both read: the AI settings draft and its
 * save, the live AI status, the library jobs and OpenRouter spend. Each tab
 * calls it for itself, so its polling stops with the tab.
 */
export function useAiCore() {
  const { showToast, showError } = useSettingsPage();
  const saveAppSettings = useUpdateAppSettings();
  const [aiDraft, setAiDraft] = useState<AiSettings>(DEFAULT_AI);
  const [embedCustom, setEmbedCustom] = useState(false);
  const [chatCustom, setChatCustom] = useState(false);
  const [aiProcessingAction, setAiProcessingAction] = useState<string | null>(
    null
  );
  const [appSettings, setAppSettings] = useLoadedAppSettings((s) => {
    if (!s.ai) return;
    const merged = { ...DEFAULT_AI, ...s.ai };
    setAiDraft(merged);
    setEmbedCustom(
      !EMBED_MODEL_OPTIONS.some(
        (o) => o.value !== "__custom__" && o.value === merged.embed_model
      )
    );
    setChatCustom(
      !CHAT_MODEL_OPTIONS.some(
        (o) => o.value !== "__custom__" && o.value === merged.chat_model
      )
    );
  });

  const aiStatusQuery = useAiStatus({ interval: 5000 });
  const aiStatus = dataOrNull(aiStatusQuery);
  const refreshAiStatus = () => {
    void aiStatusQuery.refetch();
  };
  const systemStats = dataOrNull(useSystemStats({ interval: 3000 }));
  const openRouterCosts = dataOrNull(useOpenRouterCosts({ interval: 15000 }));

  useEffect(() => {
    if (!openRouterCosts?.over_budget) return;
    const budget = openRouterCosts.weekly_budget_usd;
    if (budget == null || budget <= 0) return;
    const dayKey = Math.floor(Date.now() / 86_400_000);
    const storageKey = `horde:or-budget-warn:${budget}:${dayKey}`;
    if (getItem(storageKey)) return;
    setItem(storageKey, "1");
    const spent = formatUsdCost(openRouterCosts.d7) || "$0";
    const limit = formatUsdCost(budget) || `$${budget}`;
    if (openRouterCosts.blocked) {
      showToast(
        `OpenRouter weekly budget exceeded (${spent} / ${limit}). Calls blocked.`
      );
    } else {
      showToast(`OpenRouter weekly spend is ${spent} (limit ${limit}).`);
    }
  }, [openRouterCosts, showToast]);

  const saveAi = async (patch: Partial<AiSettings>) => {
    const next = { ...aiDraft, ...patch };
    setAiDraft(next);
    const updated = await saveAppSettings({ ai: patch }).catch((err) => {
      showError(`Could not save AI settings: ${describeError(err)}`);
      return null;
    });
    if (updated?.ai) {
      setAppSettings(updated);
      setAiDraft({ ...DEFAULT_AI, ...updated.ai });
    }
    refreshAiStatus();
  };

  const runAiProcess = async (action: AiProcessAction) => {
    if (aiProcessingAction) return;
    setAiProcessingAction(action);
    try {
      const result = await api.processAiLibrary(action);
      showToast(result.detail || "Nothing to process");
      refreshAiStatus();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Could not enqueue library";
      showToast(msg);
    } finally {
      setAiProcessingAction(null);
    }
  };

  return {
    appSettings,
    setAppSettings,
    aiDraft,
    setAiDraft,
    saveAi,
    aiStatus,
    systemStats,
    refreshAiStatus,
    openRouterCosts,
    embedCustom,
    setEmbedCustom,
    chatCustom,
    setChatCustom,
    aiProcessingAction,
    runAiProcess,
  };
}

export type AiCore = ReturnType<typeof useAiCore>;
