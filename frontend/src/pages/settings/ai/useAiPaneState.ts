import { useRef, useState } from "react";
import { getItem } from "../../../storage";
import { resolveAiPaneParam } from "../search";
import type { AiPane, AiProviderPane } from "../types";

/**
 * Which AI pane (Providers / Features / Jobs) and which provider sub-pane
 * (Local / OpenRouter) are showing. The settings page holds this, so it
 * survives switching to another tab and back.
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
  const [aiProviderPane, setAiProviderPane] = useState<AiProviderPane>("local");
  /** Set once the sub-pane has been chosen from the saved settings. */
  const providerPaneFromBackendRef = useRef(false);
  return {
    aiPane,
    setAiPane,
    aiProviderPane,
    setAiProviderPane,
    providerPaneFromBackendRef,
  };
}

export type AiPaneState = ReturnType<typeof useAiPaneState>;
