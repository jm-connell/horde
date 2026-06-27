import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "horde.continue-watching-dismissed";
const EVENT = "horde:continue-watching-dismissed";

function loadDismissed(): Set<number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as number[];
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function saveDismissed(ids: Set<number>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
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

  return { dismissed, dismiss, dismissAll, isDismissed };
}
