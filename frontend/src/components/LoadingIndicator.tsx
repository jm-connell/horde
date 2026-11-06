import type { CSSProperties } from "react";
import { useSettings } from "../hooks/useSettings";
import { isLoadingStyle, type LoadingStyle } from "../loadingStyles";

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
      {style === "arc" && <ArcMark />}
      {style === "orbit" && <OrbitMark />}
      {style === "helix" && <HelixMark />}
      {style === "infinity" && <InfinityMark />}
      {style === "cradle" && <CradleMark />}
      {style === "spokes" && <SpokesMark />}
      {style === "sweep" && <SweepMark compact={compact} />}
      {style === "clapper" && <ClapperMark />}
      {style === "play" && <PlayMark />}
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
      className={`flex flex-col items-center justify-center gap-3 text-muted ${className}`}
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

// New (preview) marks below. Each moves only by transform and opacity, so it
// keeps its pace while the page is busy, and settles into a slow breathe
// when the system asks for reduced motion (index.css, `.horde-load-new`).

function ArcMark() {
  return (
    <span className="horde-load-new horde-load-arc">
      <span className="horde-load-arc-layer">
        <span className="horde-load-arc-half horde-load-arc-half--l">
          <span className="horde-load-arc-ring" />
        </span>
        <span className="horde-load-arc-half horde-load-arc-half--r">
          <span className="horde-load-arc-ring" />
        </span>
      </span>
    </span>
  );
}

function OrbitMark() {
  return (
    <span className="horde-load-new horde-load-orbit">
      <span className="horde-load-orbit-tilt">
        <span className="horde-load-orbit-path" />
        <span className="horde-load-orbit-planet" />
        <span className="horde-load-orbit-moon" />
        <span className="horde-load-orbit-moon horde-load-orbit-moon--b" />
      </span>
    </span>
  );
}

const HELIX_COLUMNS = 7;

function HelixMark() {
  return (
    <span className="horde-load-new horde-load-helix">
      {Array.from({ length: HELIX_COLUMNS }, (_, i) => (
        <span
          key={i}
          className="horde-load-helix-col"
          // Each column is a step further round the twist.
          style={{ "--helix-delay": `${-i * 0.11}s` } as CSSProperties}
        >
          <span className="horde-load-helix-dot" />
          <span className="horde-load-helix-dot horde-load-helix-dot--b" />
        </span>
      ))}
    </span>
  );
}

/** A Gerono lemniscate (x = sin t, y = sin t cos t), the track the comet runs. */
const INFINITY_TRACK = Array.from({ length: 49 }, (_, i) => {
  const t = (i / 48) * Math.PI * 2;
  return `${(16 + Math.sin(t) * 12).toFixed(2)},${(10 + Math.sin(t) * Math.cos(t) * 12).toFixed(2)}`;
}).join(" ");

const INFINITY_TRAIL = [1, 0.62, 0.42, 0.28, 0.18, 0.1];
/** Seconds per loop (`horde-load-inf-x`); the Y bob runs exactly twice in it. */
const INFINITY_CYCLE = 1.6;

function InfinityMark() {
  return (
    <span className="horde-load-new horde-load-infinity">
      <svg
        viewBox="0 0 32 20"
        className="horde-load-infinity-track"
        aria-hidden
      >
        <polyline points={INFINITY_TRACK} />
      </svg>
      {INFINITY_TRAIL.map((opacity, i) => (
        <span
          key={i}
          className="horde-load-infinity-x"
          // A moment behind the head: a full cycle back, less the lag.
          style={{ animationDelay: `${i * 0.055 - INFINITY_CYCLE}s` }}
        >
          <span
            className="horde-load-infinity-y"
            style={{ animationDelay: `${i * 0.055 - INFINITY_CYCLE}s` }}
          >
            <span
              className="horde-load-infinity-dot"
              style={{ opacity, scale: `${1 - i * 0.1}` }}
            />
          </span>
        </span>
      ))}
    </span>
  );
}

function CradleMark() {
  return (
    <span className="horde-load-new horde-load-cradle">
      <span className="horde-load-cradle-bar" />
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`horde-load-cradle-pendulum horde-load-cradle-pendulum--${i}`}
        >
          <span className="horde-load-cradle-ball" />
        </span>
      ))}
    </span>
  );
}

const SPOKES = 8;

function SpokesMark() {
  return (
    <span className="horde-load-new horde-load-spokes">
      {Array.from({ length: SPOKES }, (_, i) => (
        <span
          key={i}
          className="horde-load-spoke"
          // The brightest spoke leads; the rest trail off behind it.
          style={{
            rotate: `${i * (360 / SPOKES)}deg`,
            opacity: 0.16 + (0.84 * (i + 1)) / SPOKES,
          }}
        />
      ))}
    </span>
  );
}

function SweepMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`horde-load-new horde-load-sweep ${compact ? "horde-load-sweep--compact" : ""}`}
    >
      <span className="horde-load-sweep-bar horde-load-sweep-bar--a" />
      <span className="horde-load-sweep-bar horde-load-sweep-bar--b" />
    </span>
  );
}

function ClapperMark() {
  return (
    <span className="horde-load-new horde-load-clapper">
      <span className="horde-load-clapper-stick" />
      <span className="horde-load-clapper-board">
        <span className="horde-load-clapper-line" />
        <span className="horde-load-clapper-line horde-load-clapper-line--short" />
      </span>
    </span>
  );
}

function PlayMark() {
  return (
    <span className="horde-load-new horde-load-play">
      <span className="horde-load-play-ring">
        <span className="horde-load-play-glint" />
      </span>
      <svg viewBox="0 0 24 24" className="horde-load-play-icon" aria-hidden>
        <path d="M9.5 7.5v9l7-4.5z" />
      </svg>
    </span>
  );
}
