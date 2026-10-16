import { createContext, useContext } from "react";
import type { AiCore } from "./useAiCore";
import type { useAiPanes } from "./useAiPanes";

/** Everything the AI panes share: the core AI state plus the panes' own state. */
export type AiPageContextValue = AiCore & ReturnType<typeof useAiPanes>;

export const AiPageContext = createContext<AiPageContextValue | null>(null);

export function useAiPage(): AiPageContextValue {
  const ctx = useContext(AiPageContext);
  if (!ctx) throw new Error("useAiPage must be used within AiPageContext");
  return ctx;
}
