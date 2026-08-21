import { describe, expect, it } from "vitest";
import {
  CUSTOM_CSS_MAX_CHARS,
  normalizeCustomCss,
  pageIdFromPath,
  sanitizeCustomCss,
} from "./customCss";

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
    expect(pageIdFromPath("/playlists/abc")).toBe("playlist");
    expect(pageIdFromPath("/history")).toBe("history");
    expect(pageIdFromPath("/download")).toBe("download");
    expect(pageIdFromPath("/import")).toBe("import");
    expect(pageIdFromPath("/review")).toBe("import");
    expect(pageIdFromPath("/nope")).toBe("other");
  });
});
