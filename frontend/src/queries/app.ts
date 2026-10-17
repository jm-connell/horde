import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

/** The server-side app settings (AI flags, catalog options); shared by every reader. */
export const appSettingsQuery = () => ({
  queryKey: queryKeys.app.settings,
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.getAppSettings({ signal }),
});

/**
 * Save app settings and put the server's answer into the cache, so screens
 * that read them (the Watch page's AI flags) never show the old values.
 */
export function useUpdateAppSettings() {
  const queryClient = useQueryClient();
  return useCallback(
    async (patch: Parameters<typeof api.updateAppSettings>[0]) => {
      const updated = await api.updateAppSettings(patch);
      queryClient.setQueryData(queryKeys.app.settings, updated);
      return updated;
    },
    [queryClient]
  );
}
