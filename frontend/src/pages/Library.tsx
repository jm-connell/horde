import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import ChannelFeed from "../components/ChannelFeed";
import ContinueWatchingRow from "../components/ContinueWatchingRow";
import { isYoutubeChannelUrl } from "../components/channelFeedYoutubeSearch";
import { HttpsNotice } from "../components/HttpsHelp";
import LibraryBulkBar from "../components/LibraryBulkBar";
import LoadingIndicator from "../components/LoadingIndicator";
import DiscoverHome from "../components/DiscoverHome";
import RecommendedHome from "../components/RecommendedHome";
import { useHomeReset } from "../context/HomeResetContext";
import { useSearch } from "../context/SearchContext";
import { useContinueWatchingDismiss } from "../hooks/useContinueWatchingDismiss";
import { useSettings } from "../hooks/useSettings";
import { useOfflineMode } from "../offline/hooks";
import { useChannelLive } from "../queries/follows";
import { OfflinePage } from "./lazy";
import ChannelControls from "./library/ChannelControls";
import ChannelHeader from "./library/ChannelHeader";
import ChannelSettingsSheet from "./library/channelSettings/ChannelSettingsSheet";
import type { ChannelSettingsSection } from "./library/channelSettings/channelSettingsText";
import HomeControls from "./library/HomeControls";
import LibraryGrid, { type LibraryGridOptions } from "./library/LibraryGrid";
import LibraryHeader from "./library/LibraryHeader";
import LibrarySidebar from "./library/LibrarySidebar";
import { QueueBottomDock, QueueSidePanel } from "./library/QueueDock";
import SearchResults from "./library/SearchResults";
import TagDrawer from "./library/TagDrawer";
import { useBulkSelection } from "./library/bulkSelection";
import { useBulkActions } from "./library/useBulkActions";
import { useChannelCatalog } from "./library/useChannelCatalog";
import { useChannelFeedControls } from "./library/useChannelFeedControls";
import { useChannelNavigation } from "./library/useChannelNavigation";
import { useGlobalSearch } from "./library/useGlobalSearch";
import { useHomeTab } from "./library/useHomeTab";
import { useLibraryLists } from "./library/useLibraryLists";
import { useLibraryQuery } from "./library/useLibraryQuery";
import { useLibraryRefresh } from "./library/useLibraryRefresh";
import { useQueueDock } from "./library/useQueueDock";
import { useSidebar } from "./library/useSidebar";
import { useTagDrawer } from "./library/useTagDrawer";

function OnlineLibrary() {
  const [settings, update] = useSettings();
  const { search } = useSearch();
  const [showAllChannels, setShowAllChannels] = useState(false);

  const {
    activeChannel,
    setActiveChannel,
    activeTag,
    setActiveTag,
    sort,
    order,
    debouncedSearch,
    mainFilters,
    handleSortChange,
    toggleOrder,
  } = useLibraryQuery(settings, update);
  const { homeTab, setHomeTab } = useHomeTab(search);

  // The nav search searches the whole library from any page. A channel opened
  // from the sidebar is page state, not a URL the nav can leave, so typing
  // there closes it here (channel pages search their feed in their own box).
  useEffect(() => {
    if (search.trim() && activeChannel) setActiveChannel(null);
  }, [search, activeChannel, setActiveChannel]);

  const isHome = !activeChannel && !activeTag;
  const onChannelPage = Boolean(activeChannel);
  // Recommended works without AI (ranked from the watch history).
  const showHomeTabs = isHome;
  // Either recommendations tab: they render their own data and order.
  const onRecommendedTab =
    showHomeTabs && (homeTab === "recommended" || homeTab === "discover");

  const { refreshKey, refreshLibrary, reloadChannels } =
    useLibraryRefresh(mainFilters);
  const { videos, loading, otherVideos, continueWatching, channels, tags } =
    useLibraryLists({
      mainFilters,
      debouncedSearch,
      activeChannel,
      // The Recommended tab renders its own data.
      skipLibrary: onRecommendedTab && !debouncedSearch,
      channelSort: settings.channelSort,
      channelOrder: settings.channelOrder,
    });
  const tagDrawer = useTagDrawer(tags, activeTag, activeChannel);
  const { hasTags, showTags, setShowTags } = tagDrawer;

  // Select mode picks across every card shown, matches first.
  const selectableVideos = useMemo(
    () => (debouncedSearch ? [...videos, ...otherVideos] : videos),
    [debouncedSearch, videos, otherVideos]
  );
  const selectableIds = useMemo(
    () => selectableVideos.map((v) => v.id),
    [selectableVideos]
  );
  const selection = useBulkSelection(selectableIds);
  const bulkBar = useBulkActions({
    selectedIds: selection.selectedIds,
    videos,
    exitSelectMode: selection.exit,
    refreshLibrary,
  });
  // The logo and Home ask for the base home page: drop the channel (from the
  // rail it never reaches the URL), the tag, the tag drawer and select mode.
  // The home tab is a saved choice, so Recommended stays put.
  const { resetKey: homeResetKey } = useHomeReset();
  const seenHomeReset = useRef(homeResetKey);
  const { exit: exitSelection } = selection;
  useEffect(() => {
    if (seenHomeReset.current === homeResetKey) return;
    seenHomeReset.current = homeResetKey;
    setActiveChannel(null);
    setActiveTag(null);
    setShowTags(false);
    setShowAllChannels(false);
    exitSelection();
  }, [
    homeResetKey,
    setActiveChannel,
    setActiveTag,
    setShowTags,
    exitSelection,
  ]);

  const globalSearch = useGlobalSearch({
    debouncedSearch,
    activeChannel,
    refreshKey,
    videos,
    otherVideos,
  });

  const sidebar = useSidebar(settings, update);
  const channelNav = useChannelNavigation({
    activeChannel,
    setActiveChannel,
    setActiveTag,
    update,
    afterNavigate: () => {
      if (sidebar.narrowViewport) sidebar.closeSidebar();
    },
    reloadChannels,
  });
  const activeChannelUrl = useMemo(() => {
    if (!activeChannel) return null;
    return (
      channels.find((c) => c.channel === activeChannel)?.channel_url ??
      channelNav.channelUrlOverrides[activeChannel] ??
      null
    );
  }, [activeChannel, channels, channelNav.channelUrlOverrides]);
  const catalog = useChannelCatalog(activeChannel, activeChannelUrl);
  const activeChannelStat = useMemo(
    () => channels.find((c) => c.channel === activeChannel) ?? null,
    [channels, activeChannel]
  );
  // The channel settings sheet: closed (undefined), open at the top (null) or
  // at one section. A different channel closes it.
  const [settingsSheet, setSettingsSheet] = useState<
    ChannelSettingsSection | null | undefined
  >(undefined);
  useEffect(() => setSettingsSheet(undefined), [activeChannel]);
  const feed = useChannelFeedControls(activeChannel);
  const channelLive = useChannelLive(
    onChannelPage && isYoutubeChannelUrl(activeChannelUrl)
      ? activeChannelUrl
      : null
  );

  const { dismiss, dismissAll, isDismissed } = useContinueWatchingDismiss();
  const visibleContinueWatching = useMemo(
    () => continueWatching.filter((v) => !isDismissed(v.id)),
    [continueWatching, isDismissed]
  );
  const showContinueRow =
    settings.showContinueWatching &&
    !activeChannel &&
    !activeTag &&
    !onRecommendedTab &&
    !debouncedSearch &&
    visibleContinueWatching.length > 0;

  const queueDock = useQueueDock({
    selectMode: selection.selectMode,
    sidebarCollapsed: settings.sidebarCollapsed,
    videoCount: videos.length,
    showContinueRow,
    loading,
  });

  const grid: LibraryGridOptions = {
    sidebarCollapsed: settings.sidebarCollapsed,
    showViewCount: sort === "view_count",
    showProgress: settings.showProgressOnAllVideos,
    selectMode: selection.selectMode,
    selectedIds: selection.selectedIds,
    onToggle: selection.toggle,
  };

  const headline = activeChannel
    ? activeChannel
    : activeTag
      ? `#${activeTag}`
      : "Home";

  const toggleTagsFromHeader = (leaveRecommended: boolean) => {
    if (leaveRecommended) {
      setHomeTab("library");
      setShowTags(true);
      return;
    }
    setShowTags((s) => !s);
  };

  return (
    <div className={`flex gap-6${queueDock.dockedBottom ? " pb-4" : ""}`}>
      {queueDock.showQueuePanel && !queueDock.queueDockedBottom && (
        <QueueSidePanel />
      )}
      <LibrarySidebar
        channels={channels}
        activeChannel={activeChannel}
        channelSort={settings.channelSort}
        sidebarCollapsed={settings.sidebarCollapsed}
        narrowViewport={sidebar.narrowViewport}
        overlayOpen={sidebar.sidebarOverlayOpen}
        overlayVisible={sidebar.sidebarOverlayVisible}
        showAllChannels={showAllChannels}
        onToggleShowAll={() => setShowAllChannels((v) => !v)}
        onSelectChannel={channelNav.selectChannel}
        onSelectRemoteChannel={channelNav.selectRemoteChannel}
        onOpen={sidebar.openSidebar}
        onClose={sidebar.closeSidebar}
      />

      <div ref={queueDock.mainContentRef} className="min-w-0 flex-1">
        {onChannelPage && activeChannel ? (
          <>
            <ChannelHeader
              channel={activeChannel}
              channelUrl={activeChannelUrl}
              stat={activeChannelStat}
              autodownload={catalog.autodownload}
              catalogProgress={catalog.catalogProgress}
              onOpenSettings={setSettingsSheet}
            />
            <ChannelControls
              channelUrl={activeChannelUrl}
              channelTab={feed.channelTab}
              onChannelTab={feed.setChannelTab}
              feedSearch={feed.feedSearch}
              onFeedSearch={feed.setFeedSearch}
              feedSort={feed.feedSort}
              onFeedSort={feed.setFeedSort}
              feedOrder={feed.feedOrder}
              onToggleFeedOrder={feed.toggleFeedOrder}
              feedLayout={feed.feedLayout}
              onFeedLayout={feed.setFeedLayout}
              showUndownloaded={settings.showUndownloadedOnChannel}
              onToggleUndownloaded={() =>
                update({
                  showUndownloadedOnChannel:
                    !settings.showUndownloadedOnChannel,
                })
              }
              catalogProgress={catalog.catalogProgress}
              youtubePrefSaving={catalog.youtubePrefSaving}
              onToggleYoutubeSearch={(value) =>
                void catalog.setChannelYoutubeSearch(value)
              }
              hasTags={hasTags}
              showTags={showTags}
              onToggleTags={() => setShowTags((s) => !s)}
            />
          </>
        ) : (
          <LibraryHeader
            headline={headline}
            isHome={isHome}
            showHomeTabs={showHomeTabs}
            onRecommendedTab={onRecommendedTab}
            homeTab={homeTab}
            onHomeTab={setHomeTab}
            hasTags={hasTags}
            showTags={showTags}
            onToggleTags={toggleTagsFromHeader}
            settings={settings}
          >
            <HomeControls
              sort={sort}
              order={order}
              onSortChange={handleSortChange}
              onToggleOrder={toggleOrder}
              showSort={!onRecommendedTab}
              showTagsButton={!isHome && !onRecommendedTab && hasTags}
              showTags={showTags}
              onToggleTags={() => setShowTags((s) => !s)}
              showSelect={!onRecommendedTab}
              selectMode={selection.selectMode}
              onToggleSelect={
                selection.selectMode ? selection.exit : selection.enter
              }
            />
          </LibraryHeader>
        )}

        {!onRecommendedTab && (activeTag || hasTags) && (
          <TagDrawer
            activeTag={activeTag}
            isHome={isHome}
            onChannelPage={onChannelPage}
            hasTags={hasTags}
            showTags={showTags}
            visibleTags={tagDrawer.visibleTags}
            hiddenTagCount={tagDrawer.hiddenTagCount}
            onToggleTags={() => setShowTags((s) => !s)}
            onSelectTag={setActiveTag}
            onShowAllTags={() => tagDrawer.setShowAllTags(true)}
          />
        )}

        {onChannelPage && feed.feedSort === "popular" && (
          <p className="mb-4 text-xs text-muted">
            Popularity is based on loaded videos, not full channel history
            (YouTube limitation).
          </p>
        )}

        {showContinueRow && !onChannelPage && !onRecommendedTab && (
          <ContinueWatchingRow
            videos={visibleContinueWatching}
            showProgress={settings.showProgressOnContinueWatching}
            onDismiss={dismiss}
            onDismissAll={dismissAll}
          />
        )}

        <div
          key={onChannelPage ? "feed" : onRecommendedTab ? homeTab : "library"}
          className="page-shell page-shell--animate"
        >
          {onChannelPage ? (
            <ChannelFeed
              channel={activeChannel!}
              channelUrl={activeChannelUrl}
              channels={channels}
              feedSearch={feed.feedSearch}
              feedSort={feed.feedSort}
              feedOrder={feed.feedOrder}
              feedLayout={feed.feedLayout}
              showUndownloaded={settings.showUndownloadedOnChannel}
              tab={feed.channelTab}
              liveEntry={channelLive.entry}
              catalogIndexing={Boolean(catalog.catalogProgress?.indexing)}
              queueDockedBottom={queueDock.dockedBottom}
              directYoutubeSearch={
                catalog.catalogProgress?.youtubeSearchEffective ?? true
              }
            />
          ) : onRecommendedTab && !debouncedSearch ? (
            homeTab === "discover" ? (
              <DiscoverHome
                sidebarCollapsed={settings.sidebarCollapsed}
                onChannelClick={channelNav.openFeedChannel}
              />
            ) : (
              <RecommendedHome sidebarCollapsed={settings.sidebarCollapsed} />
            )
          ) : loading ? (
            <LoadingIndicator />
          ) : !debouncedSearch && videos.length === 0 ? (
            <div className="py-20 text-center text-muted">
              <p className="text-lg">No videos yet.</p>
              <p className="mt-1 text-sm">
                Paste a link on the Download page or drop files into your media
                folder.
              </p>
            </div>
          ) : debouncedSearch ? (
            <SearchResults
              query={debouncedSearch}
              videos={videos}
              otherVideos={otherVideos}
              global={globalSearch}
              grid={grid}
              onChannelClick={channelNav.openFeedChannel}
            />
          ) : (
            <LibraryGrid
              videos={videos}
              searchQuery={debouncedSearch}
              options={grid}
            />
          )}
        </div>

        {selection.selectMode && selection.selectedIds.size > 0 && (
          <LibraryBulkBar {...bulkBar} />
        )}
      </div>

      {queueDock.dockedBottom && (
        <QueueBottomDock viewportWidth={sidebar.viewportWidth} />
      )}
      {settingsSheet !== undefined && activeChannel && (
        <ChannelSettingsSheet
          channel={activeChannel}
          channelUrl={activeChannelUrl}
          section={settingsSheet}
          catalog={catalog}
          onRename={(next) => channelNav.renameChannel(activeChannel, next)}
          onClose={() => setSettingsSheet(undefined)}
        />
      )}
    </div>
  );
}

export default function Library() {
  const offline = useOfflineMode();
  if (offline)
    return (
      <Suspense fallback={<LoadingIndicator label="Loading" />}>
        <OfflinePage embedded />
      </Suspense>
    );
  return (
    <>
      <HttpsNotice />
      <OnlineLibrary />
    </>
  );
}
