import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api";

interface SearchContextValue {
  search: string;
  setSearch: (value: string) => void;
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

  const setSearch = useCallback((value: string) => {
    searchRef.current = value;
    setSearchState(value);
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
    void api
      .updateAppSettings({ youtube_video_search: next })
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
  }, [youtubeVideoSearchSaving]);

  useEffect(() => {
    let active = true;
    api
      .getAppSettings()
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
  }, []);

  return (
    <SearchContext.Provider
      value={{
        search,
        setSearch,
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
