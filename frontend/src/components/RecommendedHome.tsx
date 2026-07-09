import { useEffect, useState } from "react";
import { api } from "../api";
import LoadingIndicator from "./LoadingIndicator";
import VideoCard from "./VideoCard";
import type { RecommendationSection } from "../types";

const HOME_CATEGORY_KEY = "horde.home.recommendedCategory";

function loadCategory(): string | null {
  try {
    return localStorage.getItem(HOME_CATEGORY_KEY);
  } catch {
    return null;
  }
}

export default function RecommendedHome({
  sidebarCollapsed,
}: {
  sidebarCollapsed: boolean;
}) {
  const [categories, setCategories] = useState<string[]>([]);
  const [sections, setSections] = useState<RecommendationSection[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(loadCategory);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api
      .getRecommendations(activeCategory || undefined)
      .then((data) => {
        if (!active) return;
        setCategories(data.categories);
        setSections(data.sections);
        setHint(data.hint ?? null);
      })
      .catch(() => {
        if (!active) return;
        setError("Could not load recommendations. Index more videos in Settings → AI.");
        setSections([]);
        setHint(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [activeCategory]);

  const selectCategory = (name: string | null) => {
    setActiveCategory(name);
    try {
      if (name) localStorage.setItem(HOME_CATEGORY_KEY, name);
      else localStorage.removeItem(HOME_CATEGORY_KEY);
    } catch {
      /* ignore */
    }
  };

  const chipClass = (selected: boolean) =>
    `shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
      selected
        ? "bg-accent text-ink-950"
        : "border border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
    }`;

  const gridClass = `grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
    sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
  }`;

  return (
    <div className="space-y-6">
      {(categories.length > 0 || activeCategory) && (
        <div className="relative">
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin]">
            <button
              type="button"
              onClick={() => selectCategory(null)}
              className={chipClass(!activeCategory)}
            >
              For you
            </button>
            {categories.map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => selectCategory(name)}
                className={chipClass(activeCategory === name)}
              >
                {name}
              </button>
            ))}
          </div>
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-ink-950 to-transparent"
            aria-hidden
          />
        </div>
      )}

      {hint && !loading && !error && (
        <p className="text-xs text-gray-500" title={hint}>
          {hint}
        </p>
      )}

      {loading ? (
        <LoadingIndicator />
      ) : error ? (
        <div className="py-16 text-center text-gray-500">
          <p className="text-sm">{error}</p>
        </div>
      ) : sections.length === 0 ||
        sections.every((s) => s.videos.length === 0) ? (
        <div className="py-16 text-center text-gray-500">
          <p className="text-lg">No recommendations yet.</p>
          <p className="mt-1 text-sm">
            Watch a few videos or process your library under Settings → AI.
          </p>
        </div>
      ) : (
        sections.map((section, idx) => {
          if (section.videos.length === 0) return null;
          const showDivider =
            section.kind === "more" ||
            (section.title && section.title.startsWith("End of category"));
          return (
            <section key={`${section.kind}-${section.title}-${idx}`}>
              {showDivider && (
                <div className="mb-4 flex items-center gap-3">
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                  <span className="shrink-0 text-xs text-gray-500">
                    {section.title || "End of category — other recommendations"}
                  </span>
                  <hr className="min-w-0 flex-1 border-0 border-t border-ink-700" />
                </div>
              )}
              <div className={gridClass}>
                {section.videos.map((v) => (
                  <VideoCard key={v.id} video={v} />
                ))}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
