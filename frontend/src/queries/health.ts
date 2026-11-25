import { useQuery } from "@tanstack/react-query";
import type { HealthStats } from "../types";

/** `GET /api/health`, read once per visit (version for bug reports, runtime for wording). */
export function useHealth() {
  return useQuery({
    queryKey: ["health", "version"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/health", { signal });
      return (await res.json()) as Partial<HealthStats>;
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** Where this Horde runs. Server wording until the health read has answered. */
export function useRuntime(): "server" | "desktop" {
  return useHealth().data?.runtime ?? "server";
}
