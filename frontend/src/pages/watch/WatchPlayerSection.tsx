import type { ReactNode, RefObject } from "react";
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
  children: ReactNode;
}) {
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
      <div className={playerOuterClass}>
        <div className={playerInnerClass}>
          <div ref={dockRef} className="w-full" />
        </div>
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
