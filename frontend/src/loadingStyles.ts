export const LOADING_STYLES = [
  "spinner",
  "orbit",
  "helix",
  "infinity",
  "sweep",
  "spokes",
  "dots",
  "pulse",
  "wave",
  "cube",
  "spiral",
  "swarm",
  "leapfrog",
] as const;

export type LoadingStyle = (typeof LOADING_STYLES)[number];

/**
 * Every mark moves only by transform and opacity, so it keeps its pace while
 * the page is busy.
 */
export const LOADING_STYLE_OPTIONS: {
  value: LoadingStyle;
  label: string;
  description: string;
}[] = [
  {
    value: "spinner",
    label: "Spinner",
    description: "An arc that grows and shrinks as it turns",
  },
  {
    value: "orbit",
    label: "Orbit",
    description: "Two moons circling a planet, seen at a tilt",
  },
  {
    value: "helix",
    label: "Helix",
    description: "A double strand twisting in place",
  },
  {
    value: "infinity",
    label: "Infinity",
    description: "A comet looping a figure eight",
  },
  {
    value: "sweep",
    label: "Sweep",
    description: "Two segments racing along a track",
  },
  {
    value: "spokes",
    label: "Spokes",
    description: "Fading spokes ticking round",
  },
  {
    value: "dots",
    label: "Dots",
    description: "Three beads bouncing in sequence",
  },
  {
    value: "pulse",
    label: "Pulse",
    description: "Expanding sonar rings",
  },
  {
    value: "wave",
    label: "Wave",
    description: "Equalizer bars",
  },
  {
    value: "cube",
    label: "Cube",
    description: "A wireframe cube spinning on every axis",
  },
  {
    value: "spiral",
    label: "Spiral",
    description: "Beads funneling into the center",
  },
  {
    value: "swarm",
    label: "Swarm",
    description: "Fireflies drifting on tangled paths",
  },
  {
    value: "leapfrog",
    label: "Leapfrog",
    description: "Beads hopping over each other",
  },
];

export const LOADING_STYLE_SEARCH_KEYWORDS = [
  "loading animation",
  "loader",
  ...LOADING_STYLE_OPTIONS.flatMap((o) => [
    o.value,
    o.label.toLowerCase(),
    o.description.toLowerCase(),
  ]),
  "equalizer sonar radar galaxy fireflies leapfrog",
].join(" ");

export function isLoadingStyle(value: unknown): value is LoadingStyle {
  return (
    typeof value === "string" &&
    (LOADING_STYLES as readonly string[]).includes(value)
  );
}

/**
 * Map any stored value to a kept style: `arc` became `spinner`, `bar` became
 * `sweep`, and any other removed or unknown value falls back to `dots`.
 */
export function normalizeLoadingStyle(value: unknown): LoadingStyle {
  if (isLoadingStyle(value)) return value;
  if (value === "arc") return "spinner";
  if (value === "bar") return "sweep";
  return "dots";
}
