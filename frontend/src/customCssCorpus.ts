/** Shape of customCssSanitize.corpus.json. */
export interface SpliceParts {
  targets: string[];
  removable: string[];
  noise: string[];
}

/**
 * Splice corpus over customCssSanitize.corpus.json: a dangerous construct is
 * cut at a random point, something the sanitizer removes goes in the cut, and
 * random noise goes around it. Seeded, so the same seed gives the same inputs.
 *
 * Used by the vitest idempotence test and the Playwright network check
 * (e2e/custom-css-network.spec.ts). backend/tests/test_css_sanitize.py builds
 * the same shape with Python's own seeded generator. The JSON is passed in
 * because Node (Playwright) and Vite import JSON differently.
 */
export function spliceCorpus(
  corpus: SpliceParts,
  count: number,
  seed = 20261016
): string[] {
  let state = seed;
  const below = (max: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * max);
  };
  const pick = (items: string[]): string => items[below(items.length)];
  const noise = (): string => {
    let text = "";
    for (let k = below(5); k > 0; k -= 1) text += pick(corpus.noise);
    return text;
  };
  const inputs: string[] = [];
  for (let k = 0; k < count; k += 1) {
    let text = pick(corpus.targets);
    for (let cuts = 1 + below(3); cuts > 0; cuts -= 1) {
      const cut = below(text.length + 1);
      text = text.slice(0, cut) + pick(corpus.removable) + text.slice(cut);
    }
    inputs.push(noise() + text + noise());
  }
  return inputs;
}
