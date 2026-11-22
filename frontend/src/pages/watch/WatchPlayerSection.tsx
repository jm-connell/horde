import { useEffect, type ReactNode, type RefObject } from "react";
import type { Video } from "../../types";
import SourceChangeBanners from "./SourceChangeBanners";
import WatchHeader from "./WatchHeader";
import type { StreamDownload } from "./useStreamDownload";
import type { WatchSource } from "./useWatchVideo";

/**
 * The player dock (the page registers it, see PlaybackContext) and the title block under it. The rest of the page goes in
 * `children`, inside the same padded column.
 */
export default function WatchPlayerSection({
  source,
  isMobile,
  isWide,
  channelParam,
  streamDownload,
  onVideoUpdated,
  dockRef,
  belowPlayer,
  sideways,
  children,
}: {
  source: WatchSource;
  isMobile: boolean;
  isWide: boolean;
  channelParam: string;
  streamDownload: StreamDownload;
  onVideoUpdated: (video: Video) => void;
  /** The element the player is reparented into; registered by the page. */
  dockRef: RefObject<HTMLDivElement | null>;
  /** Shown right under the player, above the title (the clip picker). */
  belowPlayer?: ReactNode;
  /**
   * A phone turned sideways on a past stream: the player and this (the live
   * chat, or the button that brings it back) fill the screen side by side.
   */
  sideways?: ReactNode;
  children: ReactNode;
}) {
  const isSideways = sideways != null;
  // Nothing behind the full-screen layout scrolls, and the nav bars step aside.
  useEffect(() => {
    if (!isSideways) return;
    const { body, documentElement } = document;
    const previous = [body.style.overflow, documentElement.style.overflow];
    body.style.overflow = "hidden";
    documentElement.style.overflow = "hidden";
    body.classList.add("watch-sideways");
    window.scrollTo(0, 0);
    return () => {
      [body.style.overflow, documentElement.style.overflow] = previous;
      body.classList.remove("watch-sideways");
    };
  }, [isSideways]);

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : `relative left-1/2 -translate-x-1/2 bg-black transition-[width] duration-300 ease-fluid motion-reduce:transition-none ${
        // Full bleed, minus the chat when it is docked at the side.
        isWide ? "w-[calc(100vw-var(--horde-chat-dock,0px))]" : "w-full"
      }`;
  const playerInnerClass = isWide && !isMobile ? "mx-auto w-full" : "w-full";
  const playerMetaClass =
    "transition-[padding] duration-300 ease-fluid motion-reduce:transition-none" +
    (isWide ? " px-3 md:px-6" : "");

  return (
    <div className="min-w-0">
      {/* The same elements in both layouts: the dock must not remount, or
          the player would lose its host. */}
      <div
        className={
          isSideways
            ? "fixed inset-0 z-40 flex bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
            : playerOuterClass
        }
        data-horde={isSideways ? "watch-sideways" : undefined}
      >
        <div
          className={
            isSideways ? "flex min-w-0 flex-1 items-center" : playerInnerClass
          }
        >
          <div ref={dockRef} className="w-full" />
        </div>
        {isSideways && (
          <div className="flex h-full shrink-0 py-2 pr-2">{sideways}</div>
        )}
      </div>

      <div className={playerMetaClass}>
        {belowPlayer}
        {source.kind === "library" && (
          <SourceChangeBanners
            video={source.video}
            onVideoUpdated={onVideoUpdated}
          />
        )}
        <WatchHeader
          source={source}
          channelParam={channelParam}
          streamDownload={streamDownload}
        />
        {children}
      </div>
    </div>
  );
}
