import type { CSSProperties } from "react";
import { useSettings } from "../hooks/useSettings";
import { normalizeLoadingStyle, type LoadingStyle } from "../loadingStyles";

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
      {style === "spinner" && <SpinnerMark />}
      {style === "orbit" && <OrbitMark />}
      {style === "helix" && <HelixMark />}
      {style === "infinity" && <InfinityMark />}
      {style === "sweep" && <SweepMark compact={compact} />}
      {style === "spokes" && <SpokesMark />}
      {style === "dots" && <DotsMark compact={compact} />}
      {style === "pulse" && <PulseMark />}
      {style === "wave" && <WaveMark compact={compact} />}
      {style === "cube" && <CubeMark />}
      {style === "spiral" && <SpiralMark />}
      {style === "swarm" && <SwarmMark />}
      {style === "leapfrog" && <LeapfrogMark />}
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
  const style = normalizeLoadingStyle(settings.loadingStyle);

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

// Every mark moves only by transform and opacity, so it keeps its pace while
// the page is busy. The root of each carries `horde-load-mark`: when the
// system asks for reduced motion the mark holds still and slowly breathes
// (index.css). Delays are negative so a mark starts mid-cycle, with no first
// frame where its parts are all in step.

const GLOW = "shadow-[0_0_8px_rgb(var(--accent)/0.4)]";

/** An inline custom property the mark's CSS reads (an index or a delay). */
function cssVar(name: string, value: string | number): CSSProperties {
  return { [name]: value } as CSSProperties;
}

function SpinnerMark() {
  return (
    <span className="horde-load-mark horde-load-spinner">
      <span className="horde-load-spinner-layer">
        <span className="horde-load-spinner-half horde-load-spinner-half--l">
          <span className="horde-load-spinner-ring" />
        </span>
        <span className="horde-load-spinner-half horde-load-spinner-half--r">
          <span className="horde-load-spinner-ring" />
        </span>
      </span>
    </span>
  );
}

function OrbitMark() {
  return (
    <span className="horde-load-mark horde-load-orbit">
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
    <span className="horde-load-mark horde-load-helix">
      {Array.from({ length: HELIX_COLUMNS }, (_, i) => (
        <span
          key={i}
          className="horde-load-helix-col"
          // Each column is a step further round the twist.
          style={cssVar("--helix-delay", `${-i * 0.11}s`)}
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
    <span className="horde-load-mark horde-load-infinity">
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

function SweepMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`horde-load-mark horde-load-sweep ${compact ? "horde-load-sweep--compact" : ""}`}
    >
      <span className="horde-load-sweep-bar horde-load-sweep-bar--a" />
      <span className="horde-load-sweep-bar horde-load-sweep-bar--b" />
    </span>
  );
}

const SPOKES = 8;

function SpokesMark() {
  return (
    <span className="horde-load-mark horde-load-spokes">
      {Array.from({ length: SPOKES }, (_, i) => (
        // The ring never turns: each spoke keeps its place and only its
        // brightness changes, one step behind the spoke before it.
        <span
          key={i}
          className="horde-load-spoke"
          style={cssVar("--spoke", i)}
        />
      ))}
    </span>
  );
}

function DotsMark({ compact }: { compact: boolean }) {
  return (
    <div
      className={`horde-load-mark horde-load-dots flex items-center ${compact ? "gap-1.5" : "gap-2"}`}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`${compact ? "h-2 w-2" : "h-2.5 w-2.5"} rounded-full bg-accent ${GLOW}`}
          style={{
            animation: "horde-load-dot 0.95s ease-in-out infinite",
            animationDelay: `${i * 0.12 - 0.95}s`,
          }}
        />
      ))}
    </div>
  );
}

function PulseMark() {
  return (
    <span className="horde-load-mark relative block h-8 w-8">
      {/* Half a cycle apart, so the rings leave at an even beat. */}
      {[0, -0.8].map((delay) => (
        <span
          key={delay}
          className="absolute inset-0 rounded-full border-2 border-accent"
          style={{
            animation: "horde-load-pulse 1.6s ease-out infinite",
            animationDelay: `${delay}s`,
          }}
        />
      ))}
      <span
        className={`absolute left-1/2 top-1/2 -ml-1 -mt-1 h-2 w-2 rounded-full bg-accent ${GLOW}`}
      />
    </span>
  );
}

function WaveMark({ compact }: { compact: boolean }) {
  return (
    <span
      className={`horde-load-mark flex items-end justify-center ${compact ? "h-7 gap-[3px]" : "h-8 gap-1"}`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`origin-bottom rounded-full bg-accent ${compact ? "h-full w-[3px]" : "h-full w-1"}`}
          style={{
            animation: "horde-load-wave 0.9s ease-in-out infinite",
            animationDelay: `${i * 0.09 - 0.9}s`,
          }}
        />
      ))}
    </span>
  );
}

const CUBE_FACES = ["front", "back", "right", "left", "top", "bottom"] as const;

function CubeMark() {
  return (
    <span className="horde-load-mark horde-load-cube-scene">
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

const SPIRAL_DOTS = 10;
/** Seconds per trip to the center (`horde-load-spiral`). */
const SPIRAL_CYCLE = 1.8;

function SpiralMark() {
  return (
    <span className="horde-load-mark horde-load-spiral">
      {Array.from({ length: SPIRAL_DOTS }, (_, i) => (
        <span
          key={i}
          className="horde-load-spiral-dot"
          style={{ animationDelay: `${-(i * SPIRAL_CYCLE) / SPIRAL_DOTS}s` }}
        />
      ))}
    </span>
  );
}

function SwarmMark() {
  return (
    <span className="horde-load-mark horde-load-swarm">
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
    <span className="horde-load-mark horde-load-leapfrog">
      {[0, 1, 2].map((i) => (
        // Three layers per bead, so the run (x), the arc (y) and the squash
        // each keep their own easing. Bead `i` is `i` leaps ahead.
        <span
          key={i}
          className="horde-load-leapfrog-x"
          style={cssVar("--leap", i)}
        >
          <span className="horde-load-leapfrog-y">
            <span className="horde-load-leapfrog-bead" />
          </span>
        </span>
      ))}
    </span>
  );
}
