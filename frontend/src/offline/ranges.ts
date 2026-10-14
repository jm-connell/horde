/** HTTP Range math for serving chunked offline media. Pure; unit tested. */

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/** Cap for open-ended `bytes=N-` requests so we never assemble a whole file. */
export const OPEN_RANGE_MAX = 8 * 1024 * 1024;

/**
 * Parse a single-range `Range` header against a known size.
 * Returns null when absent/unsupported (serve 200), "invalid" for 416.
 */
export function parseRange(
  header: string | null,
  size: number,
  openRangeMax = OPEN_RANGE_MAX,
): ByteRange | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return "invalid";
  if (a === "") {
    // Suffix range: last N bytes.
    const n = Number(b);
    if (n === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return "invalid";
  let end = b === "" ? start + openRangeMax - 1 : Number(b);
  if (end < start) return "invalid";
  end = Math.min(end, size - 1);
  return { start, end };
}

export interface ChunkSlice {
  index: number;
  /** Offset within the chunk, inclusive. */
  from: number;
  /** Offset within the chunk, exclusive. */
  to: number;
}

/** Which chunks (and which bytes of each) cover `range`. */
export function chunkSlices(range: ByteRange, chunkSize: number): ChunkSlice[] {
  const out: ChunkSlice[] = [];
  const first = Math.floor(range.start / chunkSize);
  const last = Math.floor(range.end / chunkSize);
  for (let i = first; i <= last; i++) {
    const chunkStart = i * chunkSize;
    out.push({
      index: i,
      from: Math.max(range.start, chunkStart) - chunkStart,
      to: Math.min(range.end + 1, chunkStart + chunkSize) - chunkStart,
    });
  }
  return out;
}

/** `bytes 0-99/1234` → total 1234. */
export function contentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? Number(m[1]) : null;
}
