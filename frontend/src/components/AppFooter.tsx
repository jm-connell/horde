import { useQuery } from "@tanstack/react-query";
import type { HealthStats } from "../types";
import { bugReportUrl, REPO_URL } from "./bugReport";

const LINK =
  "rounded-sm text-muted underline-offset-2 hover:text-accent hover:underline";

/** The quiet strip under every page: docs and where to report bugs. */
export default function AppFooter() {
  // Read once per visit, for the bug report link only.
  const version = useQuery({
    queryKey: ["health", "version"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/health", { signal });
      return ((await res.json()) as Partial<HealthStats>).horde_version ?? null;
    },
    staleTime: Infinity,
    retry: false,
  }).data;
  return (
    // No z-index: above the background (earlier, z-0) but below <main>'s
    // layer, which holds fixed bars such as the library's bulk actions.
    <footer
      data-horde="footer"
      className="relative mx-auto mt-auto flex w-full max-w-[1920px] flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-ink-800 px-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-5 text-xs md:px-6"
    >
      <a href="/wiki/" target="_blank" rel="noreferrer" className={LINK}>
        Docs
      </a>
      <a
        href={bugReportUrl(version)}
        target="_blank"
        rel="noreferrer"
        className={LINK}
      >
        Report a bug or idea
      </a>
      <a href={REPO_URL} target="_blank" rel="noreferrer" className={LINK}>
        Source on GitHub
      </a>
    </footer>
  );
}
