import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import LoadingIndicator from "../components/LoadingIndicator";
import {
  usePlaybackActions,
  usePlaybackSession,
} from "../context/PlaybackContext";
import { useStreamRelated } from "../queries/preview";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSettings } from "../hooks/useSettings";
import { useAuth } from "../context/AuthContext";
import { extractYouTubeId } from "../hooks/useSponsorBlock";
import ClipPanel from "./watch/ClipPanel";
import RedownloadDialog from "./watch/RedownloadDialog";
import StreamActions from "./watch/StreamActions";
import WatchActions from "./watch/WatchActions";
import WatchInfoPanels from "./watch/WatchInfoPanels";
import WatchPlayerSection from "./watch/WatchPlayerSection";
import {
  RelatedGrid,
  StreamRelatedGrid,
  WatchSidebar,
} from "./watch/WatchSidebar";
import { libraryRelatedItems, streamRelatedItems } from "./watch/relatedItems";
import { useRelatedFeed } from "./watch/useRelatedFeed";
import { useStreamDownload } from "./watch/useStreamDownload";
import { useWatchActions } from "./watch/useWatchActions";
import { useWatchAi } from "./watch/useWatchAi";
import { useWatchVideo } from "./watch/useWatchVideo";
import { ArrowIcon } from "../components/icons";

/**
 * The watch page: a library video (`/watch/:id`) or a not-yet-downloaded
 * stream (`/watch?url=`). The player itself lives in PlaybackContext and is
 * docked into this page; the pieces around it are in `./watch/`.
 */
/** `?t=` in whole seconds (Ask references link straight to a moment). */
function parseStartParam(raw: string | null): number | null {
  if (raw == null || raw === "") return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec >= 0 ? Math.floor(sec) : null;
}

export default function Watch() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const libraryId = id ? Number(id) : NaN;
  const streamUrlParam = (searchParams.get("url") || "").trim();
  const channelParam = (searchParams.get("channel") || "").trim();
  const startParam = parseStartParam(searchParams.get("t"));
  const [settings] = useSettings();
  const isMobile = useIsMobile();
  const { mode, queue } = usePlaybackSession();

  const libraryValid = Number.isFinite(libraryId) && libraryId !== 0;
  const { source, setSource, loading, error, setVideo } = useWatchVideo({
    libraryId,
    libraryValid,
    streamUrlParam,
    channelParam,
    startParam,
  });
  const streamDownload = useStreamDownload({
    source,
    setSource,
    streamUrlParam,
    libraryValid,
    channelParam,
  });
  const video = source?.kind === "library" ? source.video : null;
  const actions = useWatchActions({ video, setSource });
  const { can } = useAuth();
  // Live and past broadcasts can be clipped, and downloaded YouTube videos
  // (the clip comes from YouTube; the library file shares its timeline).
  const clip = !can("download")
    ? null
    : video
      ? video.source_url && extractYouTubeId(video.source_url, "")
        ? { url: video.source_url, title: video.title, live: false }
        : null
      : source &&
          source.kind !== "library" &&
          (source.meta.is_live || source.meta.was_live)
        ? {
            url: source.meta.source_url ?? source.url,
            title: source.meta.title ?? null,
            live: Boolean(source.meta.is_live),
          }
        : null;
  // The stream the clip picker is open for (closed on another stream).
  const [clipOpenFor, setClipOpenFor] = useState<string | null>(null);
  const clipOpen = clip != null && clipOpenFor === clip.url;
  const openClip = clip
    ? () => {
        setClipOpenFor(clip.url);
        // Back up to the video: the clip is picked while watching it.
        window.scrollTo({
          top: 0,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : "smooth",
        });
      }
    : undefined;
  const ai = useWatchAi(source, setVideo);
  const related = useRelatedFeed(video?.id);
  const streamRelated = useStreamRelated(
    source?.kind === "stream" ? source.url : undefined
  );
  const relatedItems = useMemo(
    () =>
      video
        ? libraryRelatedItems(related.videos)
        : streamRelatedItems(streamRelated.items),
    [video, related.videos, streamRelated.items]
  );

  // Registered here, above the early returns: the loading and error views must
  // not unregister the dock, or the player would jump to the mini player.
  const { registerDock } = usePlaybackActions();
  const dockRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!source) return;
    registerDock(dockRef.current);
    return () => registerDock(null);
    // Do not depend on mode — re-registering on theater toggle briefly clears
    // the dock and can collapse the player into mini layout.
  }, [registerDock, source]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <LoadingIndicator label="Loading…" />
      </div>
    );
  }

  if (error || !source) {
    const backHref = channelParam
      ? `/?channel=${encodeURIComponent(channelParam)}`
      : "/";
    return (
      <div className="mx-auto max-w-lg space-y-4 py-16 text-center">
        <p className="text-gray-300">{error || "Video unavailable"}</p>
        <Link
          to={backHref}
          className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
        >
          <ArrowIcon />
          Back
        </Link>
      </div>
    );
  }

  const isWide = !isMobile && mode === "theater";
  const showRelatedRight =
    !isMobile &&
    mode === "standard" &&
    settings.showRelatedVideos &&
    relatedItems.length > 0;
  const queueVisible = queue.length > 0;
  // Theater puts the player full-bleed, so the column only holds the details
  // under it: keep it at a readable width, centred under the video.
  const contentClass = showRelatedRight
    ? "mx-auto max-w-360 2xl:max-w-[116rem]"
    : isWide
      ? "mx-auto max-w-5xl xl:max-w-6xl"
      : "mx-auto max-w-5xl xl:max-w-6xl 2xl:max-w-[116rem]";

  return (
    <div
      className={`${contentClass} transition-[margin-top] duration-300 ease-fluid motion-reduce:transition-none ${isWide ? "-mt-6" : "mt-0"}`}
    >
      <div
        className={
          showRelatedRight
            ? "grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]"
            : undefined
        }
      >
        <WatchPlayerSection
          source={source}
          isMobile={isMobile}
          isWide={isWide}
          channelParam={channelParam}
          streamDownload={streamDownload}
          onVideoUpdated={setVideo}
          dockRef={dockRef}
          belowPlayer={
            clip && clipOpen ? (
              <ClipPanel
                key={clip.url}
                url={clip.url}
                title={clip.title}
                live={clip.live}
                library={video != null}
                onClose={() => setClipOpenFor(null)}
              />
            ) : null
          }
        >
          <WatchInfoPanels
            source={source}
            ai={ai}
            queueVisible={queueVisible}
            sidebarShown={showRelatedRight}
            columnBounded={showRelatedRight || isWide}
            onVideoUpdated={setVideo}
          />
          {video && (
            <WatchActions
              video={video}
              actions={actions}
              isMobile={isMobile}
              onVideoUpdated={setVideo}
              onSaveClip={openClip}
            />
          )}
          {!video && openClip && <StreamActions onSaveClip={openClip} />}
          {!showRelatedRight &&
            relatedItems.length > 0 &&
            (video ? (
              <RelatedGrid related={related} />
            ) : (
              <StreamRelatedGrid items={relatedItems} />
            ))}
        </WatchPlayerSection>

        {showRelatedRight && (
          <WatchSidebar
            items={relatedItems}
            sentinelRef={video ? related.sentinelRef : undefined}
            loadingMore={video ? related.loadingMore : false}
            hasQueue={queueVisible}
          />
        )}
      </div>

      {video && <RedownloadDialog video={video} actions={actions} />}
    </div>
  );
}
