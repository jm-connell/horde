import { createElement, Fragment, type ReactNode } from "react";

/**
 * Lightweight, safe markdown for AI summary/chat text.
 * Supports paragraphs, unordered/ordered lists, bold, italic, and inline code.
 * Raw HTML is never interpreted.
 */

function parseInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Prefer ** / __ / ` before single * / _.
  const re = /(\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+?`|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const token = m[0];
    if (
      (token.startsWith("**") && token.endsWith("**")) ||
      (token.startsWith("__") && token.endsWith("__"))
    ) {
      out.push(
        createElement(
          "strong",
          { key: `b-${key++}`, className: "font-semibold text-gray-200" },
          token.slice(2, -2)
        )
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      out.push(
        createElement(
          "code",
          {
            key: `c-${key++}`,
            className:
              "rounded bg-ink-950/80 px-1 py-0.5 font-mono text-[0.85em] text-gray-300",
          },
          token.slice(1, -1)
        )
      );
    } else if (
      (token.startsWith("*") && token.endsWith("*")) ||
      (token.startsWith("_") && token.endsWith("_"))
    ) {
      out.push(
        createElement(
          "em",
          { key: `i-${key++}`, className: "italic text-gray-300" },
          token.slice(1, -1)
        )
      );
    } else {
      out.push(token);
    }
    last = m.index + token.length;
  }
  if (last < text.length) {
    out.push(text.slice(last));
  }
  return out.length ? out : [text];
}

const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;

type Block =
  | { kind: "p"; text: string }
  | { kind: "ul" | "ol"; items: string[] };

function expandFlattenedLists(raw: string): string {
  // Recover list items that were collapsed onto one line:
  // "* A: foo. * B: bar." → separate lines.
  const lines = raw.split("\n");
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!/^[-*+]\s+\S/.test(trimmed)) return line;
      return trimmed.replace(/\s+([-*+])\s+(?=\S)/g, "\n$1 ");
    })
    .join("\n");
}

function parseBlocks(raw: string): Block[] {
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

  for (const line of lines) {
    const trimmed = line.trim();
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
  return blocks;
}

interface Props {
  text: string;
  className?: string;
  wrapClassName?: string;
  children?: ReactNode;
}

export default function AiMarkdown({
  text,
  className = "space-y-3 text-sm text-gray-300",
  wrapClassName,
  children,
}: Props) {
  const body = (text || "").trim();
  if (!body && !children) return null;

  const blocks = body ? parseBlocks(body) : [];

  return (
    <div className={wrapClassName || undefined}>
      {blocks.length > 0 && (
        <div className={className}>
          {blocks.map((block, i) => {
            if (block.kind === "p") {
              return (
                <p key={`p-${i}`} className="leading-relaxed">
                  {parseInline(block.text)}
                </p>
              );
            }
            const Tag = block.kind === "ol" ? "ol" : "ul";
            return createElement(
              Tag,
              {
                key: `${block.kind}-${i}`,
                className:
                  block.kind === "ol"
                    ? "list-decimal space-y-1.5 pl-5 leading-relaxed marker:text-gray-500"
                    : "list-disc space-y-1.5 pl-5 leading-relaxed marker:text-gray-500",
              },
              block.items.map((item, j) =>
                createElement(
                  "li",
                  { key: j, className: "pl-0.5" },
                  parseInline(item)
                )
              )
            );
          })}
        </div>
      )}
      {children ? <Fragment>{children}</Fragment> : null}
    </div>
  );
}
