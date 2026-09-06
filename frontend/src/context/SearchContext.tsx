import { createContext, useCallback, useContext, useRef, useState } from "react";

interface SearchContextValue {
  search: string;
  setSearch: (value: string) => void;
  committedQuery: string;
  commitSearch: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [search, setSearchState] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");
  const searchRef = useRef(search);
  searchRef.current = search;
  const setSearch = useCallback((value: string) => {
    searchRef.current = value;
    setSearchState(value);
  }, []);
  const commitSearch = useCallback(() => {
    setCommittedQuery(searchRef.current.trim());
  }, []);
  return (
    <SearchContext.Provider
      value={{ search, setSearch, committedQuery, commitSearch }}
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
