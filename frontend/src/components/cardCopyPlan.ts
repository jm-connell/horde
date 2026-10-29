/**
 * How a grid card lays out its text: title, details, resolution and action.
 *
 * Every text line is one unit tall (1.25rem): a title line, or a details line
 * (1rem) with the 0.25rem gap above it. A card's **natural** layout is the title
 * lines it needs (at most two) plus the fewest details lines that show every
 * required detail whole; the grid row is as tall as its tallest card's natural
 * layout. A card with spare units in its row spends them, a whole line at a
 * time and in this order: splitting its details over more lines, giving the
 * resolution a line of its own (bottom left), then optional details. The last
 * line always sits at the bottom of the card with the action (download, a
 * check, live) at its right end; ``CardCopy`` spreads whatever cannot be
 * filled evenly between the lines, so there is never a gap at the bottom.
 */

export const TITLE_MAX_LINES = 2;
/** One text line in rem: a title line, or a details line plus its gap. */
export const UNIT_REM = 1.25;

/** ``"c"`` is the channel, ``"r"`` the resolution; numbers index the facts. */
export type CopyItem = "c" | "r" | number;

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
  /** Width of the resolution label (0 when there is none). */
  resWidth: number;
  /** Width of the action with its leading gap (0 when there is none). */
  actionWidth: number;
  /** The gap between the end of a line's text and what follows it. */
  endGap: number;
}

export interface CopyPlan {
  titleLines: number;
  /** Details lines, top to bottom; the action ends the last one. */
  lines: CopyItem[][];
  /** The resolution ends the last line, before the action (not on a line). */
  resTrailing: boolean;
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
    item === "c"
      ? m.channelWidth
      : item === "r"
        ? m.resWidth
        : (m.factWidths[item] ?? 0)
  );
  return (
    widths.reduce((a, b) => a + b, 0) +
    Math.max(0, line.length - 1) * m.sepWidth
  );
}

function fits(lines: CopyItem[][], resTrailing: boolean, m: CopyMeasures) {
  if (m.width <= 0) return true;
  const trailing =
    (resTrailing && m.resWidth > 0 ? m.resWidth + m.endGap : 0) + m.actionWidth;
  return lines.every((line, i) => {
    const room = i === lines.length - 1 ? m.width - trailing : m.width;
    return lineWidth(line, m) <= room + 0.5;
  });
}

interface Candidate {
  lines: CopyItem[][];
  resTrailing: boolean;
  /** What it adds beyond the natural layout: a resolution line costs 1, each
   *  optional fact 2, so a free line is filled with the least new text. */
  cost: number;
}

function layouts(m: CopyMeasures, facts: number, required: number) {
  const hasChannel = m.channelWidth > 0;
  const out: Candidate[] = [];
  for (let k = 1; k <= maxLines(hasChannel, facts); k++) {
    const details = groupDetails(hasChannel, facts, k);
    const base = (facts - required) * 2;
    out.push({ lines: details, resTrailing: true, cost: base });
    if (m.resWidth > 0) {
      out.push({
        lines: [...details, ["r"]],
        resTrailing: false,
        cost: base + 1,
      });
    }
  }
  return out;
}

export function planCopy(m: CopyMeasures): CopyPlan {
  const titleLines = Math.max(1, Math.min(TITLE_MAX_LINES, m.titleNeeded));
  const required = Math.min(m.required, m.factWidths.length);
  const hasDetails =
    m.channelWidth > 0 ||
    m.factWidths.length > 0 ||
    m.resWidth > 0 ||
    m.actionWidth > 0;
  if (!hasDetails) {
    return {
      titleLines,
      lines: [],
      resTrailing: true,
      naturalUnits: titleLines,
    };
  }

  // Natural: the required facts on the fewest lines that show them whole,
  // the resolution at the end of the last one.
  const plain = layouts(m, required, required).filter((c) => c.resTrailing);
  const natural =
    plain.find((c) => fits(c.lines, true, m)) ?? plain[plain.length - 1];
  let best = natural;
  const lineCount = (c: Candidate) => Math.max(1, c.lines.length);
  const room = m.units - titleLines;

  // Spare units: the layout with the most lines that fits, adding the least.
  for (let facts = required; facts <= m.factWidths.length; facts++) {
    for (const c of layouts(m, facts, required)) {
      if (lineCount(c) > room || !fits(c.lines, c.resTrailing, m)) continue;
      const more = lineCount(c) > lineCount(best);
      const cheaper = lineCount(c) === lineCount(best) && c.cost < best.cost;
      if (more || cheaper) best = c;
    }
  }
  // An action or resolution with no details still needs its line.
  const lines = best.lines.length > 0 ? best.lines : [[]];
  return {
    titleLines,
    lines,
    resTrailing: best.resTrailing,
    naturalUnits: titleLines + lineCount(natural),
  };
}
