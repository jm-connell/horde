import { extractYouTubeId } from "../../hooks/useSponsorBlock";
import type { AskSearchHit, ChannelFeedEntry, Video } from "../../types";

/**
 * One list of search results from every source. Each result is scored by the
 * same text relevance (how much of the query its title, channel, tags and text
 * contain), weighted by where it comes from so the library leads, with a small
 * bonus for its rank in its own source (`scoreResults`). The layout then holds
 * still while sources answer late or reload (`arrangeResults`): YouTube gets
 * held places, shown as loading cards until it answers.
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

function byScore(a: ScoredItem, b: ScoredItem): number {
  return b.score - a.score;
}

/** A result card (not a held place). */
export type ScoredItem = Exclude<MixedItem, { kind: "slot" }>;

/**
 * Every source's results scored on one scale, each video once: `local` (the
 * library, catalogs and captions) and `youtube`, each best first. Keys are
 * the YouTube id when known, so a stream card that becomes a library video
 * keeps its key.
 */
export function scoreResults(input: {
  query: string;
  library: Video[];
  /** The rest of the library: a transcript hit may land on one of these. */
  otherLibrary: Video[];
  stream: ChannelFeedEntry[];
  said: AskSearchHit[];
  youtube: ChannelFeedEntry[];
}): { local: ScoredItem[]; youtube: ScoredItem[] } {
  const terms = queryTerms(input.query);
  const libraryKey = (video: Video) => {
    const yt = extractYouTubeId(video.source_url, video.file_path);
    return yt ? `yt:${yt}` : `v${video.id}`;
  };

  // Transcript hits, by video, in their own rank order.
  const momentsByYt = new Map<string, AskSearchHit[]>();
  for (const hit of input.said) {
    const list = momentsByYt.get(hit.yt_id);
    if (list) list.push(hit);
    else momentsByYt.set(hit.yt_id, [hit]);
  }
  const saidRank = new Map([...momentsByYt.keys()].map((id, i) => [id, i]));
  // The library copy each transcript hit names, when the server knows it.
  const libraryIdByYt = new Map<string, number>();
  for (const hit of input.said) {
    if (hit.library_video_id != null) {
      libraryIdByYt.set(hit.yt_id, hit.library_video_id);
    }
  }
  const used = new Set<string>();
  const momentsFor = (ytId: string | null | undefined, videoId?: number) => {
    let id = ytId ?? undefined;
    if (videoId != null && (!id || !momentsByYt.has(id))) {
      id = [...libraryIdByYt].find(([, v]) => v === videoId)?.[0];
    }
    if (!id) return [];
    const moments = momentsByYt.get(id);
    if (!moments) return [];
    used.add(id);
    return moments;
  };

  const seen = new Set<string>();
  const local: ScoredItem[] = [];
  const push = (item: ScoredItem) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    local.push(item);
  };

  const libraryItem = (
    video: Video,
    relevance: number,
    weight: number,
    rank: number,
    moments: AskSearchHit[]
  ): ScoredItem => ({
    kind: "library",
    key: libraryKey(video),
    video,
    moments,
    score:
      relevance * weight +
      LIBRARY_BOOST +
      rankBonus(rank) +
      (moments.length ? MOMENT_BOOST : 0),
  });

  input.library.forEach((video, rank) => {
    const moments = momentsFor(
      extractYouTubeId(video.source_url, video.file_path),
      video.id
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
    push(libraryItem(video, relevance, SOURCE_WEIGHT.library, rank, moments));
  });

  const remoteItem = (
    source: RemoteSource,
    entry: ChannelFeedEntry,
    rank: number,
    moments: AskSearchHit[]
  ): ScoredItem => {
    const relevance = textRelevance(terms, {
      title: entry.title ?? "",
      channel: entry.channel ?? "",
      text: [entry.match_reason?.snippet, plainSnippet(moments)]
        .filter(Boolean)
        .join(" "),
    });
    return {
      kind: "remote",
      key: entry.id ? `yt:${entry.id}` : `url:${entry.url}`,
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
    push(remoteItem("stream", entry, rank, momentsFor(entry.id)));
  });

  // What was said in videos not already shown: a library copy when there is
  // one (it did not match by its words), otherwise the video to stream.
  const otherById = new Map(input.otherLibrary.map((v) => [v.id, v]));
  const otherByYt = new Map<string, Video>();
  for (const video of input.otherLibrary) {
    const yt = extractYouTubeId(video.source_url, video.file_path);
    if (yt) otherByYt.set(yt, video);
  }
  for (const [ytId, moments] of momentsByYt) {
    if (used.has(ytId)) continue;
    const rank = saidRank.get(ytId) ?? 0;
    const libraryId = libraryIdByYt.get(ytId);
    const video =
      (libraryId != null ? otherById.get(libraryId) : undefined) ??
      otherByYt.get(ytId);
    if (video) {
      const relevance = textRelevance(terms, {
        title: video.title,
        channel: video.channel ?? "",
        text: plainSnippet(moments),
      });
      push(libraryItem(video, relevance, SOURCE_WEIGHT.said, rank, moments));
    } else {
      push(remoteItem("said", entryFromHit(moments[0]), rank, moments));
    }
  }
  local.sort(byScore);

  const youtube = input.youtube
    .map((entry, rank) => remoteItem("youtube", entry, rank, []))
    .filter((item) => !seen.has(item.key) && !!seen.add(item.key))
    .sort(byScore);
  return { local, youtube };
}

/** Results laid out for one query; later updates for it build on this. */
export interface MixedLayout {
  query: string;
  /** Item keys and held places (`slot-<n>`) in display order. */
  order: string[];
  /** Every key's latest item, kept while its source reloads. */
  items: ReadonlyMap<string, ScoredItem>;
}

const isSlot = (key: string) => key.startsWith("slot-");

/**
 * Lay the scored results out without moving what is on screen. The first
 * layout for a query waits until the library, catalogs and captions have
 * answered (null until then); it is their order by score with YouTube's
 * places held. After that, for the same query:
 *
 * - a card keeps its place and takes its source's latest data (a stream card
 *   that was downloaded becomes the library card in the same place);
 * - new cards join at the end, except YouTube's first results, which fill the
 *   held places in their score order;
 * - a card leaves only once its source has answered again without it, and a
 *   held place YouTube did not fill takes the last card, so only that one
 *   moves.
 */
export function arrangeResults(
  prev: MixedLayout | null,
  scored: { local: ScoredItem[]; youtube: ScoredItem[] },
  state: {
    query: string;
    /** The library, catalogs and captions answer this query. */
    localSettled: boolean;
    /** YouTube search is on for this query. */
    youtubeOn: boolean;
    /** YouTube answered this query. */
    youtubeSettled: boolean;
  }
): MixedLayout | null {
  const { query, localSettled, youtubeOn, youtubeSettled } = state;
  let order: string[];
  const items = new Map<string, ScoredItem>();
  if (prev && prev.query === query) {
    order = [...prev.order];
    prev.items.forEach((item, key) => items.set(key, item));
  } else {
    if (!localSettled) return null;
    order = scored.local.map((item) => item.key);
    if (youtubeOn) {
      YOUTUBE_SLOTS.forEach((pos, i) => {
        order.splice(Math.min(pos, order.length), 0, `slot-${i}`);
      });
    }
  }

  const localKeys = new Set(scored.local.map((item) => item.key));
  const youtubeKeys = new Set(scored.youtube.map((item) => item.key));
  for (const item of [...scored.local, ...scored.youtube]) {
    items.set(item.key, item);
  }

  // Leave: only once the source that showed a card has answered without it.
  order = order.filter((key) => {
    if (isSlot(key) || localKeys.has(key) || youtubeKeys.has(key)) return true;
    const item = items.get(key);
    const fromYoutube = item?.kind === "remote" && item.source === "youtube";
    return fromYoutube ? !youtubeSettled : !localSettled;
  });
  if (!youtubeOn) order = order.filter((key) => !isSlot(key));

  // Join: new local cards at the end; YouTube's fill the held places first.
  const placed = new Set(order);
  if (localSettled) {
    for (const item of scored.local) {
      if (!placed.has(item.key)) {
        order.push(item.key);
        placed.add(item.key);
      }
    }
  }
  if (youtubeSettled) {
    for (const item of scored.youtube) {
      if (placed.has(item.key)) continue;
      const slot = order.findIndex(isSlot);
      if (slot >= 0) order[slot] = item.key;
      else order.push(item.key);
      placed.add(item.key);
    }
    // Places YouTube left empty take the last card, so only it moves; held
    // places at the very end just go.
    const dropTrailing = () => {
      while (order.length && isSlot(order[order.length - 1])) order.pop();
    };
    dropTrailing();
    for (let i = order.findIndex(isSlot); i >= 0; i = order.findIndex(isSlot)) {
      order[i] = order.pop() as string;
      dropTrailing();
    }
  }

  const shown = new Set(order);
  for (const key of [...items.keys()]) {
    if (!shown.has(key)) items.delete(key);
  }
  return { query, order, items };
}

/** The layout's cards and held places, in order. */
export function layoutItems(layout: MixedLayout): MixedItem[] {
  return layout.order.map((key) => {
    const item = layout.items.get(key);
    return item ?? { kind: "slot", key };
  });
}
