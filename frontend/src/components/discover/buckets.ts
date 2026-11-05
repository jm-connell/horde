import type { RecTuning } from "../../types";

export type Bucket = keyof RecTuning["shares"];

/** The kinds of pick Recommended mixes, in the order the panel lists them. */
export const BUCKETS: { id: Bucket; label: string; hint: string }[] = [
  {
    id: "subscriptions",
    label: "From your channels",
    hint: "New uploads from channels you follow or watch a lot.",
  },
  {
    id: "similar",
    label: "More like what you watch",
    hint: "Close to your recent watching, from channels you know.",
  },
  {
    id: "new",
    label: "New channels",
    hint: "As close to your taste, from channels you have never watched.",
  },
  {
    id: "throwback",
    label: "Throwbacks",
    hint: "Interests and channels you have not touched in a while.",
  },
  {
    id: "rewatch",
    label: "Rewatch",
    hint: "Videos you finished a while ago, worth another look.",
  },
];

export const BUCKET_LABEL: Record<string, string> = {
  ...Object.fromEntries(BUCKETS.map((b) => [b.id, b.label])),
  interest: "Your interests",
};

/** Each share as a whole percent of the total (all zero reads as even). */
export function sharePercents(
  shares: RecTuning["shares"]
): Record<Bucket, number> {
  const total = BUCKETS.reduce((sum, b) => sum + shares[b.id], 0);
  return Object.fromEntries(
    BUCKETS.map((b) => [
      b.id,
      total > 0
        ? Math.round((shares[b.id] / total) * 100)
        : Math.round(100 / BUCKETS.length),
    ])
  ) as Record<Bucket, number>;
}

/** The accent tints the mix bar uses, strongest first. */
export const BUCKET_TINT: Record<Bucket, string> = {
  subscriptions: "bg-accent",
  similar: "bg-accent/70",
  new: "bg-accent/45",
  throwback: "bg-accent/25",
  rewatch: "bg-ink-600",
};
