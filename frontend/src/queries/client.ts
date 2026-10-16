import { QueryClient } from "@tanstack/react-query";

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
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
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
}
