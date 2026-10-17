import type { ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";
import { isYoutubeChannelUrl } from "../../components/channelFeedYoutubeSearch";
import { Toggle } from "../settings/ui";
import type { ChannelAutodownload } from "../../types";
import type { HomeTab } from "../libraryStorage";
import type { Settings } from "../../hooks/useSettings";
import ChannelHeader from "./ChannelHeader";
import HomeTabs from "./HomeTabs";

/**
 * The row above the list: title, home tabs, the tags / undownloaded /
 * autodownload buttons, and `children` for the page's search and sort controls.
 */
export default function LibraryHeader({
  headline,
  activeChannel,
  activeTag,
  activeChannelUrl,
  isHome,
  onChannelPage,
  showHomeTabs,
  onRecommendedTab,
  homeTab,
  onHomeTab,
  hasTags,
  showTags,
  onToggleTags,
  settings,
  onShowUndownloaded,
  autodownload,
  onOpenAutodownload,
  onRenameChannel,
  children,
}: {
  headline: string;
  activeChannel: string | null;
  activeTag: string | null;
  activeChannelUrl: string | null;
  isHome: boolean;
  onChannelPage: boolean;
  showHomeTabs: boolean;
  onRecommendedTab: boolean;
  homeTab: HomeTab;
  onHomeTab: (tab: HomeTab) => void;
  hasTags: boolean;
  showTags: boolean;
  /** Called with `true` when the click should also switch to the library tab. */
  onToggleTags: (leaveRecommended: boolean) => void;
  settings: Settings;
  onShowUndownloaded: (show: boolean) => void;
  autodownload: ChannelAutodownload | null;
  onOpenAutodownload: () => void;
  onRenameChannel: (oldName: string, newName: string) => Promise<void>;
  children: ReactNode;
}) {
  const { can } = useAuth();
  return (
    <div
      className={`flex min-w-0 items-center gap-x-2 gap-y-3 sm:gap-x-3 ${
        onChannelPage && showTags && hasTags ? "mb-2" : "mb-5"
      } ${isHome ? "max-md:flex-wrap md:flex-nowrap" : "flex-wrap"}`}
    >
      <ChannelHeader
        headline={headline}
        activeChannel={activeChannel}
        isHome={isHome}
        channelUrl={activeChannelUrl}
        onRename={onRenameChannel}
      />

      {showHomeTabs && (
        <HomeTabs
          homeTab={homeTab}
          navIndicator={settings.navIndicator}
          onSelect={onHomeTab}
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
      {activeChannel && !activeTag && (
        <label className="inline-flex shrink-0 items-center gap-2 text-sm text-gray-300">
          <span className="hidden sm:inline">Show undownloaded</span>
          <span className="sm:hidden">Undownloaded</span>
          <Toggle
            checked={settings.showUndownloadedOnChannel}
            onChange={() =>
              onShowUndownloaded(!settings.showUndownloadedOnChannel)
            }
          />
        </label>
      )}
      {activeChannel &&
        can("download") &&
        !activeTag &&
        isYoutubeChannelUrl(activeChannelUrl) && (
          <button
            type="button"
            onClick={onOpenAutodownload}
            className={`ui-panel ui-interactive shrink-0 rounded-lg border px-2.5 py-1.5 text-sm transition-colors ${
              autodownload?.enabled
                ? "border-accent bg-accent/10 text-accent"
                : "border-ink-700 bg-ink-900 text-gray-300 hover:border-accent hover:text-accent"
            }`}
          >
            Autodownload
          </button>
        )}

      <div
        data-header-filters
        className={
          onChannelPage
            ? "contents"
            : "ml-auto flex min-w-0 w-full basis-full flex-wrap items-center justify-end gap-1.5 sm:gap-2 md:w-auto md:flex-1 md:basis-auto md:flex-nowrap"
        }
      >
        {children}
      </div>
    </div>
  );
}
