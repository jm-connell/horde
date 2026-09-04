export const LOADING_STYLES = [
  "dots",
  "spinner",
  "bar",
  "orbit",
  "pulse",
  "wave",
  "comet",
  "tiles",
  "petal",
  "blob",
  "atom",
  "cube",
  "helix",
  "spiral",
  "swarm",
  "leapfrog",
  "plus",
  "split",
  "ringwalk",
  "newton",
  "bouncebox",
  "pong",
  "goo",
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
    value: "orbit",
    label: "Orbit",
    description: "A satellite circling a core",
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
    value: "blob",
    label: "Blob",
    description: "A morphing glow",
  },
  {
    value: "atom",
    label: "Atom",
    description: "Electrons on tilted orbital rings",
  },
  {
    value: "cube",
    label: "Cube",
    description: "A wireframe cube spinning on every axis",
  },
  {
    value: "helix",
    label: "Helix",
    description: "A double strand twisting past itself",
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
    value: "split",
    label: "Split",
    description: "A grid that expands and the tiles step around",
  },
  {
    value: "ringwalk",
    label: "Ring walk",
    description: "A pentagon stepping on a spinning ring",
  },
  {
    value: "newton",
    label: "Newton",
    description: "A five-bead cradle transferring a click",
  },
  {
    value: "bouncebox",
    label: "Bounce box",
    description: "Two beads ricocheting inside a frame",
  },
  {
    value: "pong",
    label: "Pong",
    description: "A paddle batting a bouncing ball",
  },
  {
    value: "goo",
    label: "Goo",
    description: "Gooey dots cycling around a plus",
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
  "equalizer sonar radar morph bloom satellite electron dna galaxy fireflies leapfrog plus split ringwalk newton cradle bouncebox pong goo metaball",
].join(" ");

export function isLoadingStyle(value: unknown): value is LoadingStyle {
  return (
    typeof value === "string" &&
    (LOADING_STYLES as readonly string[]).includes(value)
  );
}
