import { useCallback, useEffect, useState } from "react";
import { dataOrNull, useAiStatus } from "../../queries/status";
import { loadHomeTab, saveHomeTab, type HomeTab } from "../libraryStorage";

/** Library or Recommended on the home page; Recommended needs AI that is ready. */
export function useHomeTab(search: string) {
  const [homeTab, setHomeTabState] = useState<HomeTab>(loadHomeTab);
  const aiStatus = dataOrNull(useAiStatus({ interval: 15_000 }));
  const aiReady = Boolean(
    aiStatus?.ready && aiStatus.enabled && !aiStatus.paused
  );

  const setHomeTab = useCallback((tab: HomeTab) => {
    setHomeTabState(tab);
    saveHomeTab(tab);
  }, []);

  // Searching always looks in the library.
  useEffect(() => {
    if (search.trim()) setHomeTab("library");
  }, [search, setHomeTab]);

  return { homeTab, setHomeTab, aiReady };
}
