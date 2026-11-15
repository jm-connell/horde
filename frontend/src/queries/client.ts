import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./keys";

/**
 * One client per app instance (built in `App`, not at module level, so a test
 * can render with a fresh cache).
 *
 * - `networkMode: "always"`: the app has its own connectivity tracker
 *   (`offline/connectivity`) and `request()` fails fast in offline mode, so
 *   React Query must not pause fetches on `navigator.onLine`.
 * - `retry: false`: a failed load shows its error, as the hand-rolled fetches
 *   did; pollers simply try again on their next tick.
 * - `refetchOnWindowFocus` is off by default; status data opts in per query.
 * - Background tabs do not poll (`refetchIntervalInBackground: false`).
 * - Recommended's first page is kept for the whole session (see below).
 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        networkMode: "always",
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        refetchIntervalInBackground: false,
        retry: false,
      },
      mutations: {
        networkMode: "always",
        retry: false,
      },
    },
  });
  // Recommended's last first page and channel shelf stay for the session:
  // opening the tab again shows them at once while a fresh page loads (the
  // server may take seconds to rank again after something was watched).
  client.setQueryDefaults(queryKeys.discover.firstPage, { gcTime: Infinity });
  client.setQueryDefaults(queryKeys.discover.channels, { gcTime: Infinity });
  return client;
}
