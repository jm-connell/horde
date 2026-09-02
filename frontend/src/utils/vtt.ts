/** Parse YouTube-style (and plain) WebVTT into timed caption lines. */

export interface CaptionWord {
  text: string;
  startSec: number;
}

export interface CaptionLine {
  startSec: number;
  endSec: number;
  words: CaptionWord[];
  text: string;
}

const TS_RE = /(\d{1,2}):(\d{2}):(\d{2})\.(\d{3})/;
const CUE_TIMING_RE =
  /^(\d{1,2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}\.\d{3})/;
/** Per-word tags: `<00:00:01.200><c> word</c>` */
const WORD_TAG_RE =
  /<(\d{1,2}:\d{2}:\d{2}\.\d{3})><c>([^<]*)<\/c>/g;
const MIN_CUE_DURATION_SEC = 0.05;
/** Close typical YouTube inter-cue holes so the overlay doesn't blink off. */
export const CUE_GAP_FILL_SEC = 0.5;
/** Keep the last line visible this long after it ends, unless the next cue starts. */
export const CUE_HOLD_SEC = 0.85;

export function parseVttTimestamp(ts: string): number {
  const m = TS_RE.exec(ts.trim());
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4]);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  lrm: "",
  rlm: "",
};

/** Decode HTML/YouTube entities. Unknown named entities (nsps, npsp, …) → space. */
export function decodeVttEntities(raw: string): string {
  let out = raw;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(
      /&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi,
      (_full, ent: string) => {
        if (ent.startsWith("#")) {
          const hex = ent[1] === "x" || ent[1] === "X";
          const code = hex
            ? parseInt(ent.slice(2), 16)
            : parseInt(ent.slice(1), 10);
          if (!Number.isFinite(code) || code < 0) return " ";
          if (code === 160 || code === 0x202f || code === 0x2007) return " ";
          try {
            return String.fromCodePoint(code);
          } catch {
            return " ";
          }
        }
        const mapped = NAMED_ENTITIES[ent.toLowerCase()];
        if (mapped !== undefined) return mapped;
        return " ";
      }
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripTags(raw: string): string {
  return decodeVttEntities(raw)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseWordsFromLine(line: string, cueStart: number): CaptionWord[] {
  const words: CaptionWord[] = [];
  let cursor = 0;
  let sawTag = false;
  WORD_TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_TAG_RE.exec(line)) !== null) {
    if (!sawTag && match.index > 0) {
      const lead = stripTags(line.slice(0, match.index));
      if (lead) {
        for (const w of lead.split(" ").filter(Boolean)) {
          words.push({ text: w, startSec: cueStart });
        }
      }
    }
    sawTag = true;
    const wordText = decodeVttEntities(match[2]).replace(/\s+/g, " ").trim();
    if (wordText) {
      words.push({
        text: wordText,
        startSec: parseVttTimestamp(match[1]),
      });
    }
    cursor = WORD_TAG_RE.lastIndex;
  }
  if (!sawTag) {
    const plain = stripTags(line);
    if (plain) {
      for (const w of plain.split(" ").filter(Boolean)) {
        words.push({ text: w, startSec: cueStart });
      }
    }
  } else if (cursor < line.length) {
    const trail = stripTags(line.slice(cursor));
    if (trail) {
      for (const w of trail.split(" ").filter(Boolean)) {
        words.push({
          text: w,
          startSec: words[words.length - 1]?.startSec ?? cueStart,
        });
      }
    }
  }
  return words;
}

function parseWordsFromPayload(
  payloadLines: string[],
  cueStart: number,
  hasWordTags: boolean
): CaptionWord[] {
  if (hasWordTags) {
    // YouTube rollup: prior line(s) are repeats; the last non-empty line is new.
    const last = [...payloadLines].reverse().find((l) => l.trim().length > 0);
    if (!last) return [];
    return parseWordsFromLine(last, cueStart);
  }
  // Manual / pop-on: whole payload as one entry, all words at cue start.
  const plain = payloadLines.map(stripTags).filter(Boolean).join(" ");
  if (!plain) return [];
  return plain.split(" ").filter(Boolean).map((text) => ({
    text,
    startSec: cueStart,
  }));
}

/**
 * Convert a WebVTT body into caption lines with optional per-word timings.
 * Skips YouTube bridging cues, dedupes consecutive identical lines, and
 * treats unticked cues as whole-line pop-on.
 */
export function parseVttLines(text: string): CaptionLine[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = normalized.split(/\n\n+/);
  const raw: CaptionLine[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    let timingIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (CUE_TIMING_RE.test(lines[i].trim())) {
        timingIdx = i;
        break;
      }
    }
    if (timingIdx < 0) continue;

    const timingMatch = CUE_TIMING_RE.exec(lines[timingIdx].trim());
    if (!timingMatch) continue;
    const startSec = parseVttTimestamp(timingMatch[1]);
    const endSec = parseVttTimestamp(timingMatch[2]);
    if (endSec - startSec < MIN_CUE_DURATION_SEC) continue;

    const payload = lines
      .slice(timingIdx + 1)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim().length > 0);
    if (payload.length === 0) continue;

    const joined = payload.join("\n");
    const hasWordTags = WORD_TAG_RE.test(joined);
    WORD_TAG_RE.lastIndex = 0;

    const words = parseWordsFromPayload(payload, startSec, hasWordTags);
    if (words.length === 0) continue;
    const lineText = words.map((w) => w.text).join(" ");
    raw.push({ startSec, endSec, words, text: lineText });
  }

  // Dedupe consecutive identical plain text (rollup can emit duplicates),
  // keeping the union of their time ranges so coverage doesn't go hollow.
  const deduped: CaptionLine[] = [];
  for (const line of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.text === line.text) {
      prev.endSec = Math.max(prev.endSec, line.endSec);
      continue;
    }
    deduped.push(line);
  }

  // Fill small forward gaps so word reveal doesn't drop out between cues.
  // Never shorten: overlapping rollup cues must keep their full span.
  for (let i = 0; i < deduped.length; i++) {
    const next = deduped[i + 1];
    if (!next) continue;
    const gap = next.startSec - deduped[i].endSec;
    if (gap > 0 && gap < CUE_GAP_FILL_SEC) {
      deduped[i] = { ...deduped[i], endSec: next.startSec };
    }
  }

  return deduped;
}

/** Active line at time t, or -1 if none. Prefers the latest still-covering cue. */
export function findCaptionLineIndex(
  lines: CaptionLine[],
  t: number
): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startSec <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  while (ans >= 0) {
    const line = lines[ans];
    if (t >= line.startSec && t < line.endSec) return ans;
    ans -= 1;
  }
  return -1;
}

/**
 * True when playback is in a short hole after `prevIdx` and we should keep
 * showing that line instead of clearing (avoids a blink at cue boundaries).
 */
export function shouldHoldCaption(
  lines: CaptionLine[],
  prevIdx: number,
  t: number
): boolean {
  if (prevIdx < 0 || prevIdx >= lines.length) return false;
  const prev = lines[prevIdx];
  if (t < prev.startSec) return false;
  const nextStart =
    prevIdx + 1 < lines.length
      ? lines[prevIdx + 1].startSec
      : Number.POSITIVE_INFINITY;
  const holdUntil = Math.min(prev.endSec + CUE_HOLD_SEC, nextStart);
  return t < holdUntil;
}

export function revealedWordCount(line: CaptionLine, t: number): number {
  let n = 0;
  for (const w of line.words) {
    if (w.startSec <= t) n += 1;
    else break;
  }
  // Karaoke tags often timestamp the first word slightly after cue start.
  // Showing an empty boxed line for those few ms reads as a flicker.
  if (n === 0 && line.words.length > 0 && t >= line.startSec) return 1;
  return n;
}
