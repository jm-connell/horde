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
      })
      .catch(() => {
        if (!active) return;
        setError("Could not load recommendations. Index more videos in Settings → AI.");
        setSections([]);
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

  return (
    <div className="space-y-8">
      {(categories.length > 0 || activeCategory) && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => selectCategory(null)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              !activeCategory
                ? "bg-accent text-ink-950"
                : "border border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
            }`}
          >
            For you
          </button>
          {categories.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => selectCategory(name)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                activeCategory === name
                  ? "bg-accent text-ink-950"
                  : "border border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <LoadingIndicator />
      ) : error ? (
        <div className="py-16 text-center text-gray-500">
          <p className="text-sm">{error}</p>
        </div>
      ) : sections.length === 0 ? (
        <div className="py-16 text-center text-gray-500">
          <p className="text-lg">No recommendations yet.</p>
          <p className="mt-1 text-sm">
            Watch a few videos or process your library under Settings → AI.
          </p>
        </div>
      ) : (
        sections.map((section) => (
          <section key={`${section.title}-${section.seed_video_id ?? "x"}`}>
            <h2 className="mb-3 text-lg font-semibold text-gray-100">
              {section.title}
            </h2>
            <div
              className={`grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 ${
                sidebarCollapsed ? "xl:grid-cols-5" : "xl:grid-cols-4"
              }`}
            >
              {section.videos.map((v) => (
                <VideoCard key={v.id} video={v} />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
