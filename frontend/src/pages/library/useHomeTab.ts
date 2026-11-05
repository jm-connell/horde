import { useCallback, useEffect } from "react";
import { useSettings } from "../../hooks/useSettings";
import { homeTabOf, takeBrowserHomeTab, type HomeTab } from "../libraryStorage";

/**
 * Library or Recommended on the home page, saved with the account so every
 * visit, on any device, opens on the tab chosen last. A search always shows
 * the library's results, but does not change the saved choice.
 */
export function useHomeTab(search: string) {
  const [settings, update] = useSettings();
  const saved = homeTabOf(settings.homeTab);

  const setHomeTab = useCallback(
    (tab: HomeTab) => update({ homeTab: tab }),
    [update]
  );

  // A choice this browser kept before it moved to the account carries over.
  useEffect(() => {
    const old = takeBrowserHomeTab();
    if (old === "recommended") setHomeTab(old);
  }, [setHomeTab]);

  return { homeTab: search.trim() ? "library" : saved, setHomeTab };
}
