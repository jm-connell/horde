import { useCallback, useState } from "react";
import { getJson, setJson } from "../storage";
import { remPx } from "./useAnimatedClipHeight";

/**
 * Sizes the user dragged the watch page panels to (AI summary, chat input,
 * description, chapters, the description/chapters split). Kept per device in
 * localStorage, not in the account settings: a size that suits a 4K monitor
 * does not suit a laptop.
 */
export const PANEL_SIZES_KEY = "horde.watch.panelSizes";

export type PanelSizeName =
  "aiSummary" | "aiChatInput" | "metaSide" | "metaStacked" | "metaSplit";

type PanelSizes = Partial<Record<PanelSizeName, number>>;

const isPanelSizes = (v: unknown): v is PanelSizes =>
  typeof v === "object" &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

function loadSize(name: PanelSizeName): number | null {
  return getJson(PANEL_SIZES_KEY, isPanelSizes, {})[name] ?? null;
}

function saveSize(name: PanelSizeName, value: number | null) {
  const next = { ...getJson(PANEL_SIZES_KEY, isPanelSizes, {}) };
  if (value == null) delete next[name];
  else next[name] = value;
  setJson(PANEL_SIZES_KEY, next);
}

/** Clamp a dragged height between `minRem` and most of the viewport. */
export function clampPanelHeight(px: number, minRem: number): number {
  return Math.round(
    Math.min(Math.max(px, remPx(minRem)), window.innerHeight * 0.85)
  );
}

/**
 * One saved panel size. `set` changes it live (while dragging); `commit`
 * persists it; `set(null)` + `commit(null)` restores the default.
 */
export function usePanelSize(name: PanelSizeName) {
  const [size, setSize] = useState<number | null>(() => loadSize(name));
  const commit = useCallback(
    (value: number | null) => {
      setSize(value);
      saveSize(name, value);
    },
    [name]
  );
  return [size, setSize, commit] as const;
}
