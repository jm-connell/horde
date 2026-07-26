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

export function parseVttTimestamp(ts: string): number {
  const m = TS_RE.exec(ts.trim());
  if (!m) return 0;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4]);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

function stripTags(raw: string): string {
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
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
    const wordText = match[2].replace(/\s+/g, " ").trim();
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

  // Dedupe consecutive identical plain text (rollup can emit duplicates).
  const deduped: CaptionLine[] = [];
  for (const line of raw) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.text === line.text) continue;
    deduped.push(line);
  }

  // Rollup cues abut (next starts as prior ends). Stretch endSec to the next
  // start when they're nearly contiguous so word reveal never gaps.
  for (let i = 0; i < deduped.length; i++) {
    const next = deduped[i + 1];
    if (next && next.startSec - deduped[i].endSec < 0.12) {
      deduped[i] = { ...deduped[i], endSec: next.startSec };
    }
  }

  return deduped;
}

/** Active line at time t, or -1 if none. */
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
  if (ans < 0) return -1;
  if (t >= lines[ans].endSec) return -1;
  return ans;
}

export function revealedWordCount(line: CaptionLine, t: number): number {
  let n = 0;
  for (const w of line.words) {
    if (w.startSec <= t) n += 1;
    else break;
  }
  return n;
}
