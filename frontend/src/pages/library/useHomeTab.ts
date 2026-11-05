import { useCallback, useState } from "react";
import { loadHomeTab, saveHomeTab, type HomeTab } from "../libraryStorage";

/**
 * Library or Recommended on the home page, remembered between visits. A search
 * always shows the library's results, but does not change the saved choice:
 * clear the search and you are back where you were.
 */
export function useHomeTab(search: string) {
  const [saved, setSaved] = useState<HomeTab>(loadHomeTab);

  const setHomeTab = useCallback((tab: HomeTab) => {
    setSaved(tab);
    saveHomeTab(tab);
  }, []);

  return { homeTab: search.trim() ? "library" : saved, setHomeTab };
}
