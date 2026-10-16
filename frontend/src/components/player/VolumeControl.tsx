import { useRef } from "react";

interface Props {
  volume: number;
  muted: boolean;
  /** Apply a level to the video; `persist` also saves it as the preference. */
  applyVolume: (value: number, persist: boolean) => void;
  /** Save the preference once a drag ends. */
  onVolumeChange?: (volume: number) => void;
  toggleMute: () => void;
  onInteractionStart: () => void;
  onInteractionEnd: () => void;
}

function VolumeGlyph({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M11 5 6 9H2v6h4l5 4V5z" />
      {off ? (
        <path d="m22 9-6 6M16 9l6 6" />
      ) : (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      )}
    </svg>
  );
}

/** Mute button and volume slider. */
export default function VolumeControl({
  volume,
  muted,
  applyVolume,
  onVolumeChange,
  toggleMute,
  onInteractionStart,
  onInteractionEnd,
}: Props) {
  const volumePointerActive = useRef(false);
  const silent = muted || volume === 0;

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    applyVolume(Number(e.target.value), !volumePointerActive.current);
  };

  const onVolumePointerDown = () => {
    volumePointerActive.current = true;
    onInteractionStart();
  };

  const onVolumePointerUp = (e: React.PointerEvent<HTMLInputElement>) => {
    const value = Number(e.currentTarget.value);
    if (Number.isFinite(value)) onVolumeChange?.(value);
    volumePointerActive.current = false;
    onInteractionEnd();
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggleMute}
        className="ui-nav-icon ui-player-chrome flex items-center justify-center hover:text-accent"
        title={silent ? "Unmute" : "Mute"}
        aria-label={silent ? "Unmute" : "Mute"}
      >
        <VolumeGlyph off={silent} />
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={onVolume}
        onPointerDown={onVolumePointerDown}
        onPointerUp={onVolumePointerUp}
        onPointerCancel={onVolumePointerUp}
        aria-label="Volume"
        aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
        className="accent-scrubber w-[6.25rem] sm:w-[8.75rem] xl:w-[11.25rem]"
      />
    </div>
  );
}
