/**
 * Value noise read from a table of random lattice values, for effects that
 * sample a field thousands of times a frame. `noise.ts` hashes with `sin`,
 * which is fine for a few hundred particles but several times slower.
 */

const SIZE = 256;
const MASK = SIZE - 1;

export interface FastNoise {
  /** Smooth noise in [0, 1]. */
  noise: (x: number, y: number) => number;
  /** Octaves of `noise`, normalised back to [0, 1]. */
  fbm: (x: number, y: number, octaves: number) => number;
}

function seeded(seed: number): () => number {
  // mulberry32: small, fast and good enough for a texture.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createFastNoise(
  seed = Math.floor(Math.random() * 1e9)
): FastNoise {
  const random = seeded(seed);
  const table = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < table.length; i++) table[i] = random();

  const noise = (x: number, y: number): number => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const x0 = xf & MASK;
    const y0 = yf & MASK;
    const x1 = (x0 + 1) & MASK;
    const y1 = (y0 + 1) & MASK;
    const r0 = y0 * SIZE;
    const r1 = y1 * SIZE;
    // Quintic fade: no visible creases along the lattice.
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = table[r0 + x0] + (table[r0 + x1] - table[r0 + x0]) * u;
    const b = table[r1 + x0] + (table[r1 + x1] - table[r1 + x0]) * u;
    return a + (b - a) * v;
  };

  const fbm = (x: number, y: number, octaves: number): number => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let px = x;
    let py = y;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(px, py);
      norm += amp;
      amp *= 0.5;
      // Rotate between octaves so the lattice never lines up.
      const nx = px * 1.6 - py * 1.2;
      py = px * 1.2 + py * 1.6;
      px = nx + 17.3;
    }
    return sum / norm;
  };

  return { noise, fbm };
}
