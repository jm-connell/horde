import { useCallback, useEffect, useState } from "react";
import { getJson, setJson } from "../storage";

const STORAGE_KEY = "horde.continue-watching-dismissed";
const EVENT = "horde:continue-watching-dismissed";

const isIdList = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((n) => typeof n === "number");

function loadDismissed(): Set<number> {
  const ids = getJson(STORAGE_KEY, isIdList, []);
  return new Set(ids);
}

function saveDismissed(ids: Set<number>) {
  setJson(STORAGE_KEY, [...ids]);
  window.dispatchEvent(new Event(EVENT));
}

export function useContinueWatchingDismiss() {
  const [dismissed, setDismissed] = useState<Set<number>>(loadDismissed);

  useEffect(() => {
    const sync = () => setDismissed(loadDismissed());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const dismiss = useCallback((id: number) => {
    const next = new Set(loadDismissed());
    next.add(id);
    saveDismissed(next);
    setDismissed(next);
  }, []);

  const dismissAll = useCallback((ids: number[]) => {
    const next = new Set(loadDismissed());
    ids.forEach((id) => next.add(id));
    saveDismissed(next);
    setDismissed(next);
  }, []);

  const isDismissed = useCallback(
    (id: number) => dismissed.has(id),
    [dismissed]
  );

  const undismiss = useCallback((id: number) => {
    const next = new Set(loadDismissed());
    if (!next.has(id)) return;
    next.delete(id);
    saveDismissed(next);
    setDismissed(next);
  }, []);

  return { dismissed, dismiss, dismissAll, isDismissed, undismiss };
}

/** Clear a video from the dismissed set (e.g. user resumed watching). */
export function undismissContinueWatching(id: number) {
  const next = new Set(loadDismissed());
  if (!next.has(id)) return;
  next.delete(id);
  saveDismissed(next);
}
