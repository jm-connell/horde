import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

const DEFAULT_PRESETS = ["best"];

/** Download quality presets the server offers; they only change with a release. */
export function usePresets(fallback: string[] = DEFAULT_PRESETS): string[] {
  return (
    useQuery({
      queryKey: queryKeys.app.presets,
      queryFn: ({ signal }) => api.listPresets({ signal }),
      staleTime: 10 * 60_000,
    }).data ?? fallback
  );
}
