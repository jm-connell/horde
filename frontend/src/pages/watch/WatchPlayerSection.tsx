import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { usePlaybackActions } from "../../context/PlaybackContext";
import type { Video } from "../../types";
import SourceChangeBanners from "./SourceChangeBanners";
import WatchHeader from "./WatchHeader";
import type { StreamDownload } from "./useStreamDownload";
import type { WatchSource } from "./useWatchVideo";

/**
 * The player dock (the player itself is reparented into it, see
 * PlaybackContext) and the title block under it. The rest of the page goes in
 * `children`, inside the same padded column.
 */
export default function WatchPlayerSection({
  source,
  isMobile,
  isWide,
  channelParam,
  streamDownload,
  onVideoUpdated,
  children,
}: {
  source: WatchSource;
  isMobile: boolean;
  isWide: boolean;
  channelParam: string;
  streamDownload: StreamDownload;
  onVideoUpdated: (video: Video) => void;
  children: ReactNode;
}) {
  const { registerDock } = usePlaybackActions();
  const dockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    registerDock(dockRef.current);
    return () => registerDock(null);
    // Do not depend on mode — re-registering on theater toggle briefly clears
    // the dock and can collapse the player into mini layout.
  }, [registerDock, source]);

  const playerOuterClass = isMobile
    ? "relative left-1/2 w-screen -translate-x-1/2 bg-black"
    : `relative left-1/2 -translate-x-1/2 bg-black transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none ${
        isWide ? "w-screen" : "w-full"
      }`;
  const playerInnerClass = isWide && !isMobile ? "mx-auto w-full" : "w-full";
  const playerMetaClass =
    "transition-[padding] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" +
    (isWide ? " px-3 md:px-6" : "");

  return (
    <div className="min-w-0">
      <div className={playerOuterClass}>
        <div className={playerInnerClass}>
          <div ref={dockRef} className="w-full" />
        </div>
      </div>

      <div className={playerMetaClass}>
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
