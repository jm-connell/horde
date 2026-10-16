import { describe, expect, it } from "vitest";
import {
  CUSTOM_CSS_MAX_CHARS,
  isCustomCssEnabled,
  normalizeCustomCss,
  pageIdFromPath,
  sanitizeCustomCss,
  stripRemoteCss,
} from "./customCss";
import corpus from "./customCssSanitize.corpus.json";
import vectors from "./customCssSanitize.vectors.json";

describe("normalizeCustomCss", () => {
  it("keeps ordinary CSS and rejects non-strings", () => {
    expect(normalizeCustomCss(":root { --accent: 1 2 3; }")).toBe(
      ":root { --accent: 1 2 3; }"
    );
    expect(normalizeCustomCss(undefined)).toBe("");
    expect(normalizeCustomCss(12)).toBe("");
  });

  it("strips NUL bytes and caps length", () => {
    expect(normalizeCustomCss("a\0b")).toBe("ab");
    const huge = "x".repeat(CUSTOM_CSS_MAX_CHARS + 50);
    expect(normalizeCustomCss(huge).length).toBe(CUSTOM_CSS_MAX_CHARS);
  });
});

describe("isCustomCssEnabled", () => {
  it("honors an explicit boolean", () => {
    expect(isCustomCssEnabled(true, "")).toBe(true);
    expect(isCustomCssEnabled(false, "body { color: red; }")).toBe(false);
  });

  it("treats missing flag as on when CSS is already saved", () => {
    expect(isCustomCssEnabled(undefined, "body { color: red; }")).toBe(true);
    expect(isCustomCssEnabled(undefined, "   ")).toBe(false);
    expect(isCustomCssEnabled(undefined, "")).toBe(false);
  });
});

describe("sanitizeCustomCss", () => {
  it("neutralizes style-tag breakout", () => {
    expect(sanitizeCustomCss("body{}</style><script>alert(1)</script>")).toBe(
      "body{}<\\/style><script>alert(1)</script>"
    );
    expect(sanitizeCustomCss("</STYLE>")).toBe("<\\/STYLE>");
  });
});

describe("pageIdFromPath", () => {
  it("maps routes to stable data-page ids", () => {
    expect(pageIdFromPath("/")).toBe("home");
    expect(pageIdFromPath("/watch/12")).toBe("watch");
    expect(pageIdFromPath("/watch")).toBe("watch");
    expect(pageIdFromPath("/settings")).toBe("settings");
    expect(pageIdFromPath("/playlists")).toBe("playlists");
    expect(pageIdFromPath("/playlists/abc")).toBe("playlists");
    expect(pageIdFromPath("/history")).toBe("history");
    expect(pageIdFromPath("/download")).toBe("download");
    expect(pageIdFromPath("/import")).toBe("import");
    expect(pageIdFromPath("/review")).toBe("import");
    expect(pageIdFromPath("/nope")).toBe("other");
  });
});

describe("stripRemoteCss", () => {
  // The same vectors run against the server implementation in
  // backend/tests/test_css_sanitize.py.
  for (const vector of vectors) {
    it(vector.name, () => {
      expect(stripRemoteCss(vector.input)).toBe(vector.output);
    });
  }

  it("is idempotent on the vectors", () => {
    for (const vector of vectors) {
      const once = stripRemoteCss(vector.input);
      expect(stripRemoteCss(once), vector.name).toBe(once);
    }
  });

  it("is idempotent on generated inputs", () => {
    // Same splice corpus as backend/tests/test_css_sanitize.py: a dangerous
    // construct is cut at a random point, something the sanitizer removes goes
    // in the cut, and random noise goes around it. Seeded, so reproducible.
    let seed = 20261016;
    const below = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor((seed / 2 ** 32) * max);
    };
    const pick = (items: string[]): string => items[below(items.length)];
    const noise = (): string => {
      let text = "";
      for (let k = below(5); k > 0; k -= 1) text += pick(corpus.noise);
      return text;
    };
    for (let k = 0; k < 3000; k += 1) {
      let text = pick(corpus.targets);
      for (let cuts = 1 + below(3); cuts > 0; cuts -= 1) {
        const cut = below(text.length + 1);
        text = text.slice(0, cut) + pick(corpus.removable) + text.slice(cut);
      }
      const css = noise() + text + noise();
      const once = stripRemoteCss(css);
      expect(stripRemoteCss(once), JSON.stringify(css)).toBe(once);
    }
  });

  it("is applied by sanitizeCustomCss together with the style-tag guard", () => {
    expect(
      sanitizeCustomCss("@import 'x';a{background:url(//e.test/x)}</style>")
    ).toBe("a{background:none}<\\/style>");
  });
});
