import { describe, expect, it } from "vitest";
import { markdownHref, parseBlocks } from "./aiMarkdownParse";

describe("parseBlocks", () => {
  it("keeps fenced code verbatim, list-looking lines included", () => {
    const blocks = parseBlocks(
      "Run this:\n\n```yaml\nports:\n  - 8080:8080 - x\n```\nDone."
    );
    expect(blocks).toEqual([
      { kind: "p", text: "Run this:" },
      { kind: "code", text: "ports:\n  - 8080:8080 - x" },
      { kind: "p", text: "Done." },
    ]);
  });

  it("shows an unclosed fence while a reply streams", () => {
    expect(parseBlocks("```\ndocker logs horde")).toEqual([
      { kind: "code", text: "docker logs horde" },
    ]);
  });

  it("turns headings into their own block", () => {
    expect(parseBlocks("## Steps\n1. Open Settings")).toEqual([
      { kind: "h", text: "Steps" },
      { kind: "ol", items: ["Open Settings"] },
    ]);
  });
});

describe("markdownHref", () => {
  it("allows http(s) and paths on this server only", () => {
    expect(markdownHref("/wiki/ops/ai-setup/")).toBe("/wiki/ops/ai-setup/");
    expect(markdownHref("https://github.com/jm-connell/horde")).toBe(
      "https://github.com/jm-connell/horde"
    );
    expect(markdownHref("//evil.example/x")).toBeUndefined();
    expect(markdownHref("/\\evil.example")).toBeUndefined();
    expect(markdownHref("javascript:alert(1)")).toBeUndefined();
  });
});
