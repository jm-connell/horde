import { safeHref } from "../utils";

/** Block parsing and link checks for `AiMarkdown` (kept apart for tests). */

/** A link target the page may open: http(s), or a path on this server. */
export function markdownHref(url: string): string | undefined {
  return /^\/(?![/\\])/.test(url) ? url : safeHref(url);
}

const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

const HEADING_RE = /^#{1,6}\s+(.*?)\s*#*$/;
const FENCE_RE = /^\s*```/;

export type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "code"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

function expandFlattenedLists(raw: string): string {
  // Recover list items that were collapsed onto one line:
  // "* A: foo. * B: bar." → separate lines.
  const lines = raw.split("\n");
  let inFence = false;
  return lines
    .map((line) => {
      if (FENCE_RE.test(line)) inFence = !inFence;
      const trimmed = line.trim();
      if (inFence || !/^[-*+]\s+\S/.test(trimmed)) return line;
      return trimmed.replace(/\s+([-*+])\s+(?=\S)/g, "\n$1 ");
    })
    .join("\n");
}

export function parseBlocks(raw: string): Block[] {
  const lines = expandFlattenedLists(raw)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    const text = para.join(" ").replace(/\s+/g, " ").trim();
    para = [];
    if (text) blocks.push({ kind: "p", text });
  };
  const flushList = () => {
    if (list && list.items.length) blocks.push(list);
    list = null;
  };
  let code: string[] | null = null;

  for (const line of lines) {
    if (code) {
      if (FENCE_RE.test(line)) {
        blocks.push({ kind: "code", text: code.join("\n") });
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      flushPara();
      flushList();
      code = [];
      continue;
    }
    const trimmed = line.trim();
    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushPara();
      flushList();
      if (heading[1]) blocks.push({ kind: "h", text: heading[1] });
      continue;
    }
    if (!trimmed) {
      flushPara();
      flushList();
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul) {
      flushPara();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [] };
      }
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      flushPara();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [] };
      }
      list.items.push(ol[1]);
      continue;
    }
    flushList();
    para.push(trimmed);
  }
  flushPara();
  flushList();
  // An unclosed fence (a reply still streaming) shows what has arrived.
  if (code) blocks.push({ kind: "code", text: code.join("\n") });
  return blocks;
}
