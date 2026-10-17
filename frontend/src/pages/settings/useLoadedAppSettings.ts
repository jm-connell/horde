import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { appSettingsQuery } from "../../queries/app";
import type { AppSettings } from "../../types";

/**
 * The server-side app settings, read once when the tab mounts (a fresh cache
 * entry is reused). `onLoaded` runs with that first answer so a tab can seed
 * its drafts from it; later saves update the returned value through the setter.
 */
export function useLoadedAppSettings(
  onLoaded?: (settings: AppSettings) => void
): [AppSettings | null, Dispatch<SetStateAction<AppSettings | null>>] {
  const queryClient = useQueryClient();
  const [appSettings, setAppSettings] = useState<AppSettings | null>(null);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    queryClient
      .fetchQuery(appSettingsQuery())
      .then((s) => {
        setAppSettings(s);
        onLoadedRef.current?.(s);
      })
      .catch(() => undefined);
  }, [queryClient]);

  return [appSettings, setAppSettings];
}
