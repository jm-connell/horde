import { useState } from "react";
import { getItem } from "../../../storage";
import { resolveAiPaneParam } from "../search";
import type { AiPane } from "../types";

/**
 * Which AI pane (Providers / Features / Jobs) is showing. The settings page
 * holds this, so it survives switching to another tab and back.
 */
export function useAiPaneState() {
  const [aiPane, setAiPane] = useState<AiPane>(() => {
    const fromUrl = resolveAiPaneParam(
      new URLSearchParams(window.location.search).get("pane")
    );
    if (fromUrl) return fromUrl;
    const v = getItem("horde.aiPane");
    if (v === "providers" || v === "features" || v === "jobs") return v;
    return "providers";
  });
  return { aiPane, setAiPane };
}

export type AiPaneState = ReturnType<typeof useAiPaneState>;
