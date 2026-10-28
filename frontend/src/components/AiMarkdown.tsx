import { createElement, Fragment, type ReactNode } from "react";
import { markdownHref, parseBlocks } from "./aiMarkdownParse";

/**
 * Lightweight, safe markdown for AI summary/chat text.
 * Supports paragraphs, headings, unordered/ordered lists, fenced code, bold,
 * italic, inline code and links (http(s) or a path on this server).
 * Raw HTML is never interpreted.
 */

function parseInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Links first, then ** / __ / ` before single * / _.
  const re =
    /(\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+?\*\*|__[^_\n]+?__|`[^`\n]+?`|\*[^*\n]+?\*|_[^_\n]+?_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      out.push(text.slice(last, m.index));
    }
    const token = m[0];
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/.exec(token);
    if (link) {
      const href = markdownHref(link[2]);
      out.push(
        href
          ? createElement(
              "a",
              {
                key: `a-${key++}`,
                href,
                target: "_blank",
                rel: "noreferrer",
                className: "text-accent underline underline-offset-2",
              },
              link[1]
            )
          : link[1]
      );
    } else if (
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
              "rounded-sm bg-ink-950/80 px-1 py-0.5 font-mono text-[0.85em] text-gray-300",
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
            if (block.kind === "h") {
              return (
                <p
                  key={`h-${i}`}
                  className="font-semibold leading-relaxed text-gray-200"
                >
                  {parseInline(block.text)}
                </p>
              );
            }
            if (block.kind === "code") {
              return (
                <pre
                  key={`code-${i}`}
                  className="horde-scrollbar overflow-x-auto rounded-md bg-ink-950/80 px-3 py-2 font-mono text-[0.85em] leading-snug text-gray-300"
                >
                  <code>{block.text}</code>
                </pre>
              );
            }
            const Tag = block.kind === "ol" ? "ol" : "ul";
            return createElement(
              Tag,
              {
                key: `${block.kind}-${i}`,
                className:
                  block.kind === "ol"
                    ? "list-decimal space-y-1.5 pl-5 leading-relaxed marker:text-muted"
                    : "list-disc space-y-1.5 pl-5 leading-relaxed marker:text-muted",
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
