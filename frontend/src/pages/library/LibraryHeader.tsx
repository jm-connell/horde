import type { ReactNode } from "react";
import type { HomeTab } from "../libraryStorage";
import type { Settings } from "../../hooks/useSettings";
import HomeTabs from "./HomeTabs";

/**
 * The row above the home and tag lists: title, home tabs, the tags button and
 * `children` for the page's search and sort controls. Channel pages have
 * their own header (ChannelHeader).
 */
export default function LibraryHeader({
  headline,
  isHome,
  showHomeTabs,
  onRecommendedTab,
  homeTab,
  onHomeTab,
  showDiscover,
  hasTags,
  showTags,
  onToggleTags,
  settings,
  children,
}: {
  headline: string;
  isHome: boolean;
  showHomeTabs: boolean;
  onRecommendedTab: boolean;
  homeTab: HomeTab;
  onHomeTab: (tab: HomeTab) => void;
  showDiscover: boolean;
  hasTags: boolean;
  showTags: boolean;
  /** Called with `true` when the click should also switch to the library tab. */
  onToggleTags: (leaveRecommended: boolean) => void;
  settings: Settings;
  children: ReactNode;
}) {
  return (
    <div
      className={`mb-5 flex min-w-0 items-center gap-x-2 gap-y-3 sm:gap-x-3 ${
        isHome ? "max-md:flex-wrap md:flex-nowrap" : "flex-wrap"
      }`}
    >
      <h1
        className={`${
          isHome ? "sr-only lg:not-sr-only lg:flex" : "flex"
        } shrink-0 items-center gap-2 text-2xl font-bold text-gray-100`}
      >
        {headline}
      </h1>

      {showHomeTabs && (
        <HomeTabs
          homeTab={homeTab}
          navIndicator={settings.navIndicator}
          onSelect={onHomeTab}
          showDiscover={showDiscover}
        />
      )}
      {isHome && hasTags && (
        <button
          type="button"
          onClick={() => onToggleTags(onRecommendedTab)}
          aria-pressed={showTags && !onRecommendedTab}
          className={`ui-panel ui-interactive shrink-0 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
            showTags && !onRecommendedTab
              ? "border-accent bg-accent/10 text-accent"
              : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
          }`}
        >
          {showTags && !onRecommendedTab ? "Hide tags" : "Tags"}
        </button>
      )}

      <div
        data-header-filters
        className="ml-auto flex min-w-0 w-full basis-full flex-wrap items-center justify-end gap-1.5 sm:gap-2 md:w-auto md:flex-1 md:basis-auto md:flex-nowrap"
      >
        {children}
      </div>
    </div>
  );
}
