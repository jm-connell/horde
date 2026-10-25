import { useCallback, useEffect, useState } from "react";
import { loadHomeTab, saveHomeTab, type HomeTab } from "../libraryStorage";

/** Library or Recommended on the home page. */
export function useHomeTab(search: string) {
  const [homeTab, setHomeTabState] = useState<HomeTab>(loadHomeTab);

  const setHomeTab = useCallback((tab: HomeTab) => {
    setHomeTabState(tab);
    saveHomeTab(tab);
  }, []);

  // Searching always looks in the library.
  useEffect(() => {
    if (search.trim()) setHomeTab("library");
  }, [search, setHomeTab]);

  return { homeTab, setHomeTab };
}
