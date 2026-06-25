import { Fragment } from "react";

const URL_RE = /(https?:\/\/[^\s]+)/g;

// Trailing punctuation that is almost always sentence punctuation, not URL.
function splitTrailingPunctuation(url: string): [string, string] {
  const match = url.match(/[.,;:!?)\]]+$/);
  if (!match) return [url, ""];
  return [url.slice(0, -match[0].length), match[0]];
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
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
