import { createContext, useCallback, useContext, useState } from "react";
import { useSearch } from "./SearchContext";

interface HomeResetContextValue {
  /** Bumped each time the user asks for the base home page again. */
  resetKey: number;
  /**
   * Put the home page back to how it looks on a fresh load: no search, and a
   * change to `resetKey` so the page drops its channel, tag and select mode.
   * The home tab (Library or Recommended) is a saved preference and is kept.
   * The caller still has to send the user to `/`.
   */
  resetHome: () => void;
}

const HomeResetContext = createContext<HomeResetContextValue | null>(null);

export function HomeResetProvider({ children }: { children: React.ReactNode }) {
  const { clearSearch } = useSearch();
  const [resetKey, setResetKey] = useState(0);
  const resetHome = useCallback(() => {
    clearSearch();
    setResetKey((k) => k + 1);
  }, [clearSearch]);

  return (
    <HomeResetContext.Provider value={{ resetKey, resetHome }}>
      {children}
    </HomeResetContext.Provider>
  );
}

export function useHomeReset(): HomeResetContextValue {
  const ctx = useContext(HomeResetContext);
  if (!ctx)
    throw new Error("useHomeReset must be used within HomeResetProvider");
  return ctx;
}
