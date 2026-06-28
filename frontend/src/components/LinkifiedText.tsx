import { Fragment, type ReactNode } from "react";
import {
  parseInlineTimestamp,
  TIMESTAMP_INLINE_RE,
} from "../utils";

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Trailing punctuation that is almost always sentence punctuation, not URL.
function splitTrailingPunctuation(url: string): [string, string] {
  const match = url.match(/[.,;:!?)\]]+$/);
  if (!match) return [url, ""];
  return [url.slice(0, -match[0].length), match[0]];
}

function seekTo(sec: number) {
  window.dispatchEvent(new CustomEvent("horde:seek", { detail: { sec } }));
}

function renderTextWithTimestamps(text: string, keyPrefix: string) {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  const re = new RegExp(TIMESTAMP_INLINE_RE.source, TIMESTAMP_INLINE_RE.flags);
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(
        <Fragment key={`${keyPrefix}-t-${i++}`}>
          {text.slice(lastIndex, match.index)}
        </Fragment>
      );
    }
    const label = match[0];
    const sec = parseInlineTimestamp(match);
    parts.push(
      <button
        key={`${keyPrefix}-ts-${i++}`}
        type="button"
        onClick={() => seekTo(sec)}
        className="text-accent hover:underline"
      >
        {label}
      </button>
    );
    lastIndex = match.index + label.length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <Fragment key={`${keyPrefix}-t-${i}`}>{text.slice(lastIndex)}</Fragment>
    );
  }

  return parts.length > 0 ? parts : text;
}

export default function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          const [href, trailing] = splitTrailingPunctuation(part);
          return (
            <Fragment key={i}>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {href}
              </a>
              {trailing}
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>{renderTextWithTimestamps(part, String(i))}</Fragment>
        );
      })}
    </>
  );
}
