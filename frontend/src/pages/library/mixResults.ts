import { extractYouTubeId } from "../../hooks/useSponsorBlock";
import type { AskSearchHit, ChannelFeedEntry, Video } from "../../types";

/**
 * One list of search results from every source. Each result is scored by the
 * same text relevance (how much of the query its title, channel, tags and text
 * contain), weighted by where it comes from so the library leads, with a small
 * bonus for its rank in its own source. YouTube results arrive late, so they
 * get fixed places in the list (placeholders until they load) and never move
 * the cards around them.
 */

export type RemoteSource = "stream" | "youtube" | "said";

export type MixedItem =
  | {
      kind: "library";
      key: string;
      video: Video;
      moments: AskSearchHit[];
      score: number;
    }
  | {
      kind: "remote";
      key: string;
      source: RemoteSource;
      entry: ChannelFeedEntry;
      moments: AskSearchHit[];
      score: number;
    }
  | { kind: "slot"; key: string };

/** How much each source's relevance counts. The library leads. */
export const SOURCE_WEIGHT: Record<"library" | RemoteSource, number> = {
  library: 1,
  said: 0.85,
  stream: 0.8,
  youtube: 0.75,
};
/** Added to every library result on top of its weight. */
export const LIBRARY_BOOST = 0.15;
/** Added when what a video says matches too. */
export const MOMENT_BOOST = 0.1;
/** Up to this much for being first in its own source, fading down the list. */
const RANK_BONUS = 0.1;

/** Places kept for YouTube results (0-based), so late results move nothing. */
export const YOUTUBE_SLOTS = [4, 9, 14, 19];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "for",
  "how",
  "in",
  "is",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with",
]);

const FIELD_WEIGHT = { title: 3, channel: 2, tags: 1.5, text: 1 } as const;
type Fields = Partial<Record<keyof typeof FIELD_WEIGHT, string>>;

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The query's words that carry meaning (all of them when every one is a stop word). */
export function queryTerms(query: string): string[] {
  const all = words(query);
  const kept = all.filter((w) => !STOPWORDS.has(w));
  return [...new Set(kept.length ? kept : all)];
}

function matches(term: string, fieldWords: string[]): boolean {
  // Longer terms also match their endings: "belt" finds "belts".
  return fieldWords.some((w) =>
    term.length >= 3 ? w.startsWith(term) : w === term
  );
}

/**
 * How well the fields match the query, from 0 to about 1.3: the share of its
 * words found (each counted in the best field it appears in), plus a bonus for
 * the whole phrase.
 */
export function textRelevance(terms: string[], fields: Fields): number {
  if (!terms.length) return 0;
  const split = Object.entries(fields).map(
    ([name, text]) =>
      [FIELD_WEIGHT[name as keyof Fields], words(text ?? "")] as const
  );
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const [weight, fieldWords] of split) {
      if (weight > best && matches(term, fieldWords)) best = weight;
    }
    total += best;
  }
  let score = total / (FIELD_WEIGHT.title * terms.length);
  if (terms.length > 1) {
    const phrase = terms.join(" ");
    if (
      words(fields.title ?? "")
        .join(" ")
        .includes(phrase)
    )
      score += 0.2;
    else if (
      Object.values(fields).some((t) =>
        words(t ?? "")
          .join(" ")
          .includes(phrase)
      )
    ) {
      score += 0.1;
    }
  }
  return score;
}

function rankBonus(rank: number): number {
  return (RANK_BONUS * 5) / (5 + rank);
}

/** The caption text (the highlight markers split words like spaces do). */
function plainSnippet(hits: AskSearchHit[]): string {
  return hits.map((h) => h.snippet).join(" ");
}

function libraryFloor(video: Video): number {
  // A match by meaning or captions may share no words with the query.
  const source = video.match_reason?.source;
  if (source === "captions") return 0.35;
  if (source === "related") return 0.25;
  return 0;
}

function youtubeUrl(ytId: string): string {
  return `https://www.youtube.com/watch?v=${ytId}`;
}

/** A transcript hit's video as a card entry (it is not downloaded). */
function entryFromHit(hit: AskSearchHit): ChannelFeedEntry {
  return {
    id: hit.yt_id,
    url: youtubeUrl(hit.yt_id),
    title: hit.title ?? null,
    channel: hit.channel_name ?? null,
    published_at: hit.published_at ?? null,
    in_library: false,
    youtube_watched: false,
  };
}

function byScore(a: MixedItem, b: MixedItem): number {
  return (b.kind === "slot" ? 0 : b.score) - (a.kind === "slot" ? 0 : a.score);
}

export function mixResults(input: {
  query: string;
  library: Video[];
  /** The rest of the library: a transcript hit may land on one of these. */
  otherLibrary: Video[];
  stream: ChannelFeedEntry[];
  said: AskSearchHit[];
  /** Null while YouTube search is off; `pending` while it is still searching. */
  youtube: { entries: ChannelFeedEntry[]; pending: boolean } | null;
}): MixedItem[] {
  const terms = queryTerms(input.query);

  // Transcript hits, by video, in their own rank order.
  const momentsByYt = new Map<string, AskSearchHit[]>();
  for (const hit of input.said) {
    const list = momentsByYt.get(hit.yt_id);
    if (list) list.push(hit);
    else momentsByYt.set(hit.yt_id, [hit]);
  }
  const saidRank = new Map([...momentsByYt.keys()].map((id, i) => [id, i]));
  const used = new Set<string>();
  const takeMoments = (ytId: string | null | undefined) => {
    if (!ytId) return [];
    const moments = momentsByYt.get(ytId);
    if (!moments) return [];
    used.add(ytId);
    return moments;
  };

  const local: MixedItem[] = [];
  const libraryIds = new Set<number>();
  input.library.forEach((video, rank) => {
    libraryIds.add(video.id);
    const moments = takeMoments(
      extractYouTubeId(video.source_url, video.file_path)
    );
    const relevance = Math.max(
      libraryFloor(video),
      textRelevance(terms, {
        title: video.title,
        channel: video.channel ?? "",
        tags: video.tags.join(" "),
        text: [video.description, video.notes].filter(Boolean).join(" "),
      })
    );
    local.push({
      kind: "library",
      key: `v${video.id}`,
      video,
      moments,
      score:
        relevance * SOURCE_WEIGHT.library +
        LIBRARY_BOOST +
        rankBonus(rank) +
        (moments.length ? MOMENT_BOOST : 0),
    });
  });

  const remoteItem = (
    source: RemoteSource,
    entry: ChannelFeedEntry,
    rank: number,
    moments: AskSearchHit[]
  ): MixedItem => {
    const relevance = textRelevance(terms, {
      title: entry.title ?? "",
      channel: entry.channel ?? "",
      text: [entry.match_reason?.snippet, plainSnippet(moments)]
        .filter(Boolean)
        .join(" "),
    });
    return {
      kind: "remote",
      key: `${source}:${entry.id ?? entry.url}`,
      source,
      entry,
      moments,
      score:
        relevance * SOURCE_WEIGHT[source] +
        rankBonus(rank) +
        (moments.length && source !== "said" ? MOMENT_BOOST : 0),
    };
  };

  input.stream.forEach((entry, rank) => {
    local.push(remoteItem("stream", entry, rank, takeMoments(entry.id)));
  });

  // What was said in videos not already shown: a library copy when there is
  // one (it did not match by its words), otherwise the video to stream.
  const otherByYt = new Map<string, Video>();
  for (const video of input.otherLibrary) {
    const yt = extractYouTubeId(video.source_url, video.file_path);
    if (yt && !libraryIds.has(video.id)) otherByYt.set(yt, video);
  }
  for (const [ytId, moments] of momentsByYt) {
    if (used.has(ytId)) continue;
    const rank = saidRank.get(ytId) ?? 0;
    const video = otherByYt.get(ytId);
    if (video) {
      const relevance = textRelevance(terms, {
        title: video.title,
        channel: video.channel ?? "",
        text: plainSnippet(moments),
      });
      local.push({
        kind: "library",
        key: `v${video.id}`,
        video,
        moments,
        score:
          relevance * SOURCE_WEIGHT.said +
          LIBRARY_BOOST +
          rankBonus(rank) +
          MOMENT_BOOST,
      });
    } else {
      local.push(remoteItem("said", entryFromHit(moments[0]), rank, moments));
    }
  }

  local.sort(byScore);
  if (!input.youtube) return local;

  // YouTube's best results take the kept places; the rest join by score
  // below the last of them, so nothing above moves when they arrive.
  if (input.youtube.pending) {
    return placeInSlots(
      local,
      YOUTUBE_SLOTS.map((_, i) => ({ kind: "slot", key: `slot-${i}` }))
    );
  }
  const youtube = input.youtube.entries
    .map((entry, rank) => remoteItem("youtube", entry, rank, []))
    .sort(byScore);
  const slotted = youtube.slice(0, YOUTUBE_SLOTS.length);
  const placed = placeInSlots(local, slotted);
  const lastSlot = placed.findIndex(
    (item) => item === slotted[slotted.length - 1]
  );
  const head = placed.slice(0, lastSlot + 1);
  const tail = [
    ...placed.slice(lastSlot + 1),
    ...youtube.slice(slotted.length),
  ];
  return [...head, ...tail.sort(byScore)];
}

/** Put `fill` at the kept places (or right after the last local result). */
function placeInSlots(local: MixedItem[], fill: MixedItem[]): MixedItem[] {
  const out = [...local];
  fill.forEach((item, i) => {
    out.splice(Math.min(YOUTUBE_SLOTS[i], out.length), 0, item);
  });
  return out;
}
