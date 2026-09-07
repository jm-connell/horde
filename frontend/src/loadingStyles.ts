export const LOADING_STYLES = [
  "dots",
  "spinner",
  "bar",
  "pulse",
  "wave",
  "comet",
  "tiles",
  "petal",
  "cube",
  "spiral",
  "swarm",
  "leapfrog",
  "plus",
  "ringwalk",
] as const;

export type LoadingStyle = (typeof LOADING_STYLES)[number];

export const LOADING_STYLE_OPTIONS: {
  value: LoadingStyle;
  label: string;
  description: string;
}[] = [
  {
    value: "dots",
    label: "Dots",
    description: "Three beads bouncing in sequence",
  },
  {
    value: "spinner",
    label: "Spinner",
    description: "Classic rotating ring",
  },
  {
    value: "bar",
    label: "Bar",
    description: "Indeterminate sweep on a track",
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
    value: "comet",
    label: "Comet",
    description: "A bright head with a fading tail",
  },
  {
    value: "tiles",
    label: "Tiles",
    description: "Squares lighting up in a spiral",
  },
  {
    value: "petal",
    label: "Petal",
    description: "A ring of beads blooming around the center",
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
  {
    value: "plus",
    label: "Plus",
    description: "Arms fold in, then the plus turns",
  },
  {
    value: "ringwalk",
    label: "Ring walk",
    description: "A pentagon stepping on a spinning ring",
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
  "equalizer sonar radar bloom galaxy fireflies leapfrog plus ringwalk",
].join(" ");

export function isLoadingStyle(value: unknown): value is LoadingStyle {
  return (
    typeof value === "string" &&
    (LOADING_STYLES as readonly string[]).includes(value)
  );
}
