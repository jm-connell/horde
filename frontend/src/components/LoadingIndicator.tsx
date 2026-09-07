import { useSettings } from "../hooks/useSettings";
import {
  isLoadingStyle,
  type LoadingStyle,
} from "../loadingStyles";

export function LoadingMark({
  style,
  compact = false,
}: {
  style: LoadingStyle;
  compact?: boolean;
}) {
  return (
    <div
      className="pointer-events-none flex h-8 items-center justify-center"
      aria-hidden
    >
      {style === "dots" && <DotsMark compact={compact} />}
      {style === "spinner" && <SpinnerMark compact={compact} />}
      {style === "bar" && <BarMark compact={compact} />}
      {style === "pulse" && <PulseMark />}
      {style === "wave" && <WaveMark compact={compact} />}
      {style === "comet" && <CometMark />}
      {style === "tiles" && <TilesMark />}
      {style === "petal" && <PetalMark />}
      {style === "cube" && <CubeMark />}
      {style === "spiral" && <SpiralMark />}
      {style === "swarm" && <SwarmMark />}
      {style === "leapfrog" && <LeapfrogMark />}
      {style === "plus" && <PlusMark />}
      {style === "ringwalk" && <RingwalkMark />}
    </div>
  );
}

export default function LoadingIndicator({
  label = "Loading",
  className = "py-20",
  labelVisible = false,
}: {
  label?: string;
  className?: string;
  /** When true, show the label on screen (not only to screen readers). */
  labelVisible?: boolean;
}) {
  const [settings] = useSettings();
  const style: LoadingStyle = isLoadingStyle(settings.loadingStyle)
    ? settings.loadingStyle
    : "dots";

  return (
    <div
      className={`flex flex-col items-center justify-center gap-3 text-gray-500 ${className}`}
      role="status"
      aria-live="polite"
    >
      <LoadingMark style={style} />
      {labelVisible ? (
        <span className="max-w-xs px-3 text-center text-sm text-gray-300">
          {label}
        </span>
      ) : (
        <span className="sr-only">{label}</span>
      )}
    </div>
  );
}

function DotsMark({ compact }: { compact: boolean }) {
  return (
    <div className={`flex items-center ${compact ? "gap-1.5" : "gap-2"}`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`${compact ? "h-2 w-2" : "h-2.5 w-2.5"} rounded-full bg-accent shadow-[0_0_10px_rgb(var(--accent)/0.45)]`}
          style={{
            animation: "horde-load-dot 0.95s ease-in-out infinite",
            animationDelay: `${i * 0.12}s`,
          }}
        />
      ))}
    </div>
  );
}

function SpinnerMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`${compact ? "h-7 w-7" : "h-8 w-8"} rounded-full border-2 border-ink-600 border-t-accent shadow-[0_0_12px_rgb(var(--accent)/0.25)]`}
      style={{ animation: "horde-load-spin 0.65s linear infinite" }}
    />
  );
}

function BarMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`relative overflow-hidden rounded-full bg-ink-700 ${
        compact ? "h-1 w-14" : "h-1.5 w-32"
      }`}
    >
      <span
        className="absolute inset-y-0 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent)/0.5)]"
        style={{ animation: "horde-load-bar 1s ease-in-out infinite" }}
      />
    </span>
  );
}

function PulseMark() {
  return (
    <span className="relative block h-8 w-8">
      {[0, 0.55].map((delay) => (
        <span
          key={delay}
          className="absolute inset-0 rounded-full border-2 border-accent"
          style={{
            animation: "horde-load-pulse 1.6s ease-out infinite",
            animationDelay: `${delay}s`,
          }}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_10px_rgb(var(--accent)/0.5)]" />
    </span>
  );
}

function WaveMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`flex items-end justify-center ${compact ? "h-7 gap-[3px]" : "h-8 gap-1"}`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`origin-bottom rounded-full bg-accent ${compact ? "h-full w-[3px]" : "h-full w-1"}`}
          style={{
            animation: "horde-load-wave 0.9s ease-in-out infinite",
            animationDelay: `${i * 0.09}s`,
          }}
        />
      ))}
    </span>
  );
}

function CometMark() {
  return <span className="horde-load-comet" />;
}

function TilesMark() {
  return (
    <span className="grid h-7 w-7 grid-cols-2 gap-1">
      {[0, 0.12, 0.36, 0.24].map((delay, i) => (
        <span
          key={i}
          className="rounded-[3px] bg-accent"
          style={{
            animation: "horde-load-tile 1.15s ease-in-out infinite",
            animationDelay: `${delay}s`,
          }}
        />
      ))}
    </span>
  );
}

function PetalMark() {
  return (
    <span className="relative block h-8 w-8">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="absolute inset-0"
          style={{ transform: `rotate(${i * 60}deg)` }}
        >
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2">
            <span
              className="block h-full w-full rounded-full bg-accent"
              style={{
                animation: "horde-load-petal 1.05s ease-in-out infinite",
                animationDelay: `${i * 0.09}s`,
              }}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

const CUBE_FACES = ["front", "back", "right", "left", "top", "bottom"] as const;

function CubeMark() {
  return (
    <span className="horde-load-cube-scene">
      <span className="horde-load-cube">
        {CUBE_FACES.map((face) => (
          <span
            key={face}
            className={`horde-load-cube-face horde-load-cube-face--${face}`}
          />
        ))}
      </span>
    </span>
  );
}

function SpiralMark() {
  const count = 10;
  const duration = 1.8;
  return (
    <span className="horde-load-spiral">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="horde-load-spiral-dot"
          style={{ animationDelay: `${-(i * duration) / count}s` }}
        />
      ))}
    </span>
  );
}

function SwarmMark() {
  return (
    <span className="horde-load-swarm">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className={`horde-load-swarm-dot horde-load-swarm-dot--${i}`}
        />
      ))}
    </span>
  );
}

function LeapfrogMark() {
  return (
    <span className="horde-load-leapfrog">
      <span className="horde-load-leapfrog-pad horde-load-leapfrog-pad--l" />
      <span className="horde-load-leapfrog-pad horde-load-leapfrog-pad--r" />
      <span className="horde-load-leapfrog-hop horde-load-leapfrog-hop--a" />
      <span className="horde-load-leapfrog-hop horde-load-leapfrog-hop--b" />
    </span>
  );
}

function PlusMark() {
  return (
    <span className="horde-load-plus">
      <span className="horde-load-plus-arm horde-load-plus-arm--n" />
      <span className="horde-load-plus-arm horde-load-plus-arm--e" />
      <span className="horde-load-plus-arm horde-load-plus-arm--s" />
      <span className="horde-load-plus-arm horde-load-plus-arm--w" />
      <span className="horde-load-plus-core" />
    </span>
  );
}

function RingwalkMark() {
  return (
    <span className="horde-load-ringwalk">
      <span className="horde-load-ringwalk-ring" />
      <span className="horde-load-ringwalk-pent" />
    </span>
  );
}
