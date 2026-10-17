import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { UpdateControl } from "../types";
import { queryKeys } from "./keys";

/** The host script is working on (or about to work on) an update. */
export function isUpdateActive(c: UpdateControl | undefined | null): boolean {
  return c?.state === "requested" || c?.state === "running";
}

/**
 * Milliseconds until the next read. Fast while an update is under way (or
 * while the server is unreachable mid-update), moderate while the host watcher
 * is not set up yet (so the page notices when the admin finishes setup), slow
 * otherwise.
 */
export function updatePollInterval(c: UpdateControl | undefined): number {
  if (!c) return 15_000;
  if (isUpdateActive(c)) return 3_000;
  if (!c.watcher_connected) return 15_000;
  return 60_000;
}

/**
 * Admin-only state of the "Update now" button. A failed read keeps the last
 * good data (TanStack default); `unreachable` is true when that last data says
 * an update was under way, which is expected while the container restarts.
 */
export function useUpdateControl() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: queryKeys.system.update,
    queryFn: ({ signal }) => api.updateControl({ signal }),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
    refetchInterval: (query) => updatePollInterval(query.state.data),
  });
  const data = q.data;
  const unreachable = q.isError && isUpdateActive(data);

  // Request ids this page saw in progress; a later "updated" for one of them
  // means this page's bundle is stale and should reload.
  const watched = useRef(new Set<string>());
  const [updatedHere, setUpdatedHere] = useState(false);
  useEffect(() => {
    if (!data?.request_id) return;
    if (isUpdateActive(data)) watched.current.add(data.request_id);
    else if (data.state === "updated" && watched.current.has(data.request_id))
      setUpdatedHere(true);
  }, [data]);

  const publish = (next: UpdateControl) =>
    qc.setQueryData(queryKeys.system.update, next);

  return {
    control: data ?? null,
    unreachable,
    updatedHere,
    request: async () => publish(await api.requestUpdate()),
    cancel: async () => publish(await api.cancelUpdate()),
  };
}
