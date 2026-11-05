import type { ReactNode } from "react";
import type { HomeTab } from "../libraryStorage";
import type { Settings } from "../../hooks/useSettings";
import SourceLegend from "../../components/discover/SourceLegend";
import HomeTabs from "./HomeTabs";

/**
 * The row above the home and tag lists: title, home tabs (with the
 * Recommended+ outline legend beside them) and `children` for the page's
 * search and sort controls. Channel pages have
 * their own header (ChannelHeader).
 */
export default function LibraryHeader({
  headline,
  isHome,
  showHomeTabs,
  homeTab,
  onHomeTab,
  showDiscover,
  settings,
  children,
}: {
  headline: string;
  isHome: boolean;
  showHomeTabs: boolean;
  homeTab: HomeTab;
  onHomeTab: (tab: HomeTab) => void;
  showDiscover: boolean;
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
      {showHomeTabs && homeTab === "discover" && <SourceLegend />}

      <div
        data-header-filters
        className="ml-auto flex min-w-0 w-full basis-full flex-wrap items-center justify-end gap-1.5 sm:gap-2 md:w-auto md:flex-1 md:basis-auto md:flex-nowrap"
      >
        {children}
      </div>
    </div>
  );
}
