/**
 * How a grid card lays out its text: title, details and the trailing status.
 *
 * Every text line is one unit tall (1.25rem): a title line, or a details line
 * (1rem) with the 0.25rem gap above it. A card's **natural** layout is the title
 * lines it needs (at most two) plus the fewest details lines that show every
 * detail without cutting one off; the grid row is as tall as its tallest card's
 * natural layout. A card with spare units in its row spends them, in order, on
 * splitting its details over more lines and then on optional details, each
 * only when that fills a whole unit. Whatever cannot be filled stays below the
 * text, never between the title and the details.
 *
 * Trailing status (resolution, download, live) sits at the end of the last
 * details line, so it never takes a line of its own.
 */

export const TITLE_MAX_LINES = 2;
/** One text line in rem: a title line, or a details line plus its gap. */
export const UNIT_REM = 1.25;

/** ``"c"`` is the channel; numbers index the facts. */
export type CopyItem = "c" | number;

export interface CopyMeasures {
  /** Lines the full title takes at this width. */
  titleNeeded: number;
  /** Whole units the card's text box has room for (0 when not measured yet). */
  units: number;
  /** Width of the text box. */
  width: number;
  /** Width of the channel name (0 when the card has none). */
  channelWidth: number;
  /** Widths of the facts, in reading order. */
  factWidths: number[];
  /** How many leading facts are always shown; the rest are optional. */
  required: number;
  /** Width of the " · " between two details on one line. */
  sepWidth: number;
  /** Width of the trailing status with its leading gap (0 when there is none). */
  trailingWidth: number;
}

export interface CopyPlan {
  titleLines: number;
  /** Details lines, top to bottom; the trailing status ends the last one. */
  lines: CopyItem[][];
  /** Units of the natural layout (what the card asks of its row). */
  naturalUnits: number;
}

/** Facts ``0..count-1`` over ``lineCount`` lines, in order, fuller lines first. */
function spread(count: number, lineCount: number): number[][] {
  const out: number[][] = [];
  let next = 0;
  for (let line = 0; line < lineCount; line++) {
    const size = Math.ceil((count - next) / (lineCount - line));
    out.push(Array.from({ length: size }, (_, i) => next + i));
    next += size;
  }
  return out.filter((l) => l.length > 0);
}

/** The details over ``k`` lines: the channel first, alone once there are two. */
export function groupDetails(
  hasChannel: boolean,
  factCount: number,
  k: number
): CopyItem[][] {
  if (!hasChannel) return spread(factCount, Math.min(k, factCount));
  if (k <= 1 || factCount === 0) {
    return [["c", ...Array.from({ length: factCount }, (_, i) => i)]];
  }
  return [["c"], ...spread(factCount, Math.min(k - 1, factCount))];
}

function maxLines(hasChannel: boolean, factCount: number): number {
  return Math.max(1, (hasChannel ? 1 : 0) + factCount);
}

function lineWidth(line: CopyItem[], m: CopyMeasures): number {
  const widths = line.map((item) =>
    item === "c" ? m.channelWidth : (m.factWidths[item] ?? 0)
  );
  return (
    widths.reduce((a, b) => a + b, 0) +
    Math.max(0, line.length - 1) * m.sepWidth
  );
}

function fits(lines: CopyItem[][], m: CopyMeasures): boolean {
  if (m.width <= 0) return true;
  return lines.every((line, i) => {
    const last = i === lines.length - 1;
    const room = last ? m.width - m.trailingWidth : m.width;
    return lineWidth(line, m) <= room + 0.5;
  });
}

export function planCopy(m: CopyMeasures): CopyPlan {
  const hasChannel = m.channelWidth > 0;
  const titleLines = Math.max(1, Math.min(TITLE_MAX_LINES, m.titleNeeded));
  const hasDetails =
    hasChannel || m.factWidths.length > 0 || m.trailingWidth > 0;
  if (!hasDetails) return { titleLines, lines: [], naturalUnits: titleLines };

  // Natural: the required facts on as few lines as show them whole.
  const required = Math.min(m.required, m.factWidths.length);
  const kReqMax = maxLines(hasChannel, required);
  let k0 = kReqMax;
  for (let k = 1; k <= kReqMax; k++) {
    if (fits(groupDetails(hasChannel, required, k), m)) {
      k0 = k;
      break;
    }
  }
  let best = { lines: groupDetails(hasChannel, required, k0), facts: required };
  const naturalUnits = titleLines + best.lines.length;
  const room = m.units - titleLines;

  // Spare units: more lines first, then optional facts, one whole line at a time.
  for (let facts = required; facts <= m.factWidths.length; facts++) {
    for (let k = 1; k <= maxLines(hasChannel, facts); k++) {
      const lines = groupDetails(hasChannel, facts, k);
      if (lines.length > room || lines.length <= best.lines.length) continue;
      if (fits(lines, m)) best = { lines, facts };
    }
  }
  // Trailing status with no details still needs its line.
  const lines = best.lines.length > 0 ? best.lines : [[]];
  return {
    titleLines,
    lines,
    naturalUnits: Math.max(naturalUnits, titleLines + 1),
  };
}
