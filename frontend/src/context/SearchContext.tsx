import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { appSettingsQuery, useUpdateAppSettings } from "../queries/app";

interface SearchContextValue {
  search: string;
  setSearch: (value: string) => void;
  clearSearch: () => void;
  committedQuery: string;
  commitSearch: () => void;
  youtubeVideoSearch: boolean;
  youtubeVideoSearchSaving: boolean;
  setYoutubeVideoSearch: (value: boolean) => void;
  toggleYoutubeVideoSearch: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [search, setSearchState] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const [youtubeVideoSearch, setYoutubeVideoSearchState] = useState(true);
  const [youtubeVideoSearchSaving, setYoutubeVideoSearchSaving] =
    useState(false);
  const searchRef = useRef(search);
  searchRef.current = search;
  const youtubeRef = useRef(true);
  youtubeRef.current = youtubeVideoSearch;

  const queryClient = useQueryClient();
  const saveAppSettings = useUpdateAppSettings();
  const setSearch = useCallback((value: string) => {
    searchRef.current = value;
    setSearchState(value);
  }, []);
  /** Drop the query and its results, as on a fresh load of the app. */
  const clearSearch = useCallback(() => {
    searchRef.current = "";
    setSearchState("");
    setCommittedQuery("");
  }, []);
  const commitSearch = useCallback(() => {
    setCommittedQuery(searchRef.current.trim());
  }, []);
  const setYoutubeVideoSearch = useCallback((value: boolean) => {
    youtubeRef.current = value;
    setYoutubeVideoSearchState(value);
  }, []);
  const toggleYoutubeVideoSearch = useCallback(() => {
    if (youtubeVideoSearchSaving) return;
    const next = !youtubeRef.current;
    youtubeRef.current = next;
    setYoutubeVideoSearchState(next);
    setYoutubeVideoSearchSaving(true);
    void saveAppSettings({ youtube_video_search: next })
      .then((s) => {
        const value = s.youtube_video_search ?? next;
        youtubeRef.current = value;
        setYoutubeVideoSearchState(value);
      })
      .catch(() => {
        youtubeRef.current = !next;
        setYoutubeVideoSearchState(!next);
      })
      .finally(() => setYoutubeVideoSearchSaving(false));
  }, [youtubeVideoSearchSaving, saveAppSettings]);

  useEffect(() => {
    let active = true;
    queryClient
      .fetchQuery(appSettingsQuery())
      .then((s) => {
        if (!active) return;
        const value = s.youtube_video_search ?? true;
        youtubeRef.current = value;
        setYoutubeVideoSearchState(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [queryClient]);

  return (
    <SearchContext.Provider
      value={{
        search,
        setSearch,
        clearSearch,
        committedQuery,
        commitSearch,
        youtubeVideoSearch,
        youtubeVideoSearchSaving,
        setYoutubeVideoSearch,
        toggleYoutubeVideoSearch,
      }}
    >
      {children}
    </SearchContext.Provider>
  );
}

export function useSearch(): SearchContextValue {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used within SearchProvider");
  return ctx;
}
