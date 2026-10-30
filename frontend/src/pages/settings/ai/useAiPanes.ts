import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api";
import { appSettingsQuery } from "../../../queries/app";
import { setItem } from "../../../storage";
import type { AiWorkloadProfile } from "../../../types";
import { DEFAULT_AI } from "../constants";
import { useSettingsPage } from "../context";
import { firstMatchingAiPane } from "../search";
import type { AiPaneState } from "./useAiPaneState";
import type { AiCore } from "./useAiCore";

/** State of the AI tab's panes (Providers, Features, Jobs) on top of the shared AI core. */
export function useAiPanes(core: AiCore, paneState: AiPaneState) {
  const { aiPane, setAiPane } = paneState;
  const { q, showToast } = useSettingsPage();
  const queryClient = useQueryClient();
  const { appSettings, setAppSettings, setAiDraft, saveAi, refreshAiStatus } =
    core;
  const [reindexPrompt, setReindexPrompt] = useState<string | null>(null);
  const [catchUpScope, setCatchUpScope] = useState<"all_recent" | "all_full">(
    "all_recent"
  );
  const [individualStepsOpen, setIndividualStepsOpen] = useState(false);

  // Search auto-switch to the pane holding the match.
  useEffect(() => {
    if (!q) return;
    const pane = firstMatchingAiPane(q);
    if (pane && pane !== aiPane) {
      setAiPane(pane);
      setItem("horde.aiPane", pane);
    }
  }, [q, aiPane, setAiPane]);

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

  /** Save a model choice; a new embedding model offers to rebuild the indexes. */
  const saveModels = async (patch: {
    chat_model?: string;
    help_model?: string;
    embed_model?: string;
  }) => {
    const prevEmbed = (appSettings?.ai.embed_model ?? "").trim();
    const embed = patch.embed_model?.trim();
    const embedChanged =
      embed !== undefined && embed !== "" && embed !== prevEmbed;
    await saveAi(patch);
    if (embedChanged && prevEmbed) {
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
