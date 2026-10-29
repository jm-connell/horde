import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import CardTitle from "./CardTitle";
import { planCopy, UNIT_REM, type CopyItem } from "./cardCopyPlan";

export interface CardFact {
  text: string;
  /** Tooltip, when the fact is a short form of something longer. */
  title?: string;
}

const SEP = " · ";
const TITLE_CLASS =
  "wrap-break-word text-sm font-semibold leading-5 text-gray-100 group-hover:text-accent";

function remPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function contentBox(el: HTMLElement): { width: number; height: number } {
  const s = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    width:
      rect.width -
      (parseFloat(s.paddingLeft) || 0) -
      (parseFloat(s.paddingRight) || 0),
    height:
      rect.height -
      (parseFloat(s.paddingTop) || 0) -
      (parseFloat(s.paddingBottom) || 0),
  };
}

function useNode<T extends HTMLElement>(): [
  T | null,
  (node: T | null) => void,
] {
  const [node, setNode] = useState<T | null>(null);
  return [node, useCallback((next: T | null) => setNode(next), [])];
}

/**
 * The text under a grid card's thumbnail: a title of one or two lines, then
 * the channel and facts (date, views, ...), the resolution, and ``action``
 * (download, a check, live) at the bottom right. ``cardCopyPlan`` decides the
 * lines; see there for the rules.
 *
 * The card claims its natural height only (an invisible spacer), so a row is
 * as tall as its tallest card's natural text. The text is drawn on top over
 * the whole box: a card in a taller row fills the spare lines, and the lines
 * are spread from the top to the bottom of the box, so the last one (and the
 * action) always sits at the bottom and nothing is left empty below it. That
 * never changes the card's own height, so rows cannot grow from it. The box
 * must be the card's growing part (``flex-1`` in an ``h-full`` card).
 */
export default function CardCopy({
  title,
  channel,
  renderChannel,
  facts,
  required = facts.length,
  resolution,
  action,
  className = "",
}: {
  title: string;
  channel?: string | null;
  /** The channel, given its text classes (a link to the channel). */
  renderChannel?: (className: string) => ReactNode;
  facts: CardFact[];
  /** Facts from this index on are optional: shown only to fill spare lines. */
  required?: number;
  /** "1080p": at the end of the last line, or its own line to fill a row. */
  resolution?: string | null;
  /** Always at the bottom right: download, downloaded, live. */
  action?: ReactNode;
  /** Classes for the box (padding, background). */
  className?: string;
}) {
  const [box, boxRef] = useNode<HTMLDivElement>();
  const [titleSizer, titleSizerRef] = useNode<HTMLSpanElement>();
  const [sizers, sizersRef] = useNode<HTMLDivElement>();
  const [actionEl, actionRef] = useNode<HTMLSpanElement>();
  const [measures, setMeasures] = useState({
    titleNeeded: 1,
    units: 0,
    width: 0,
    channelWidth: 0,
    factWidths: [] as number[],
    sepWidth: 0,
    resWidth: 0,
    actionWidth: 0,
    endGap: 0,
  });

  const factKey = facts.map((f) => f.text).join("\n");
  useLayoutEffect(() => {
    if (!box || !titleSizer || !sizers) return;
    const measure = () => {
      const unit = UNIT_REM * remPx();
      const content = contentBox(box);
      const lineHeight = parseFloat(getComputedStyle(titleSizer).lineHeight);
      const titleNeeded = Math.max(
        1,
        Math.round(
          titleSizer.getBoundingClientRect().height /
            (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : unit)
        )
      );
      const widthOf = (selector: string) =>
        sizers.querySelector<HTMLElement>(selector)?.getBoundingClientRect()
          .width ?? 0;
      const next = {
        titleNeeded,
        units: Math.floor((content.height + 1) / unit),
        width: content.width,
        channelWidth: channel ? widthOf("[data-sizer='c']") : 0,
        factWidths: facts.map((_, i) => widthOf(`[data-sizer='${i}']`)),
        sepWidth: widthOf("[data-sizer='sep']"),
        resWidth: resolution ? widthOf("[data-sizer='r']") : 0,
        actionWidth: actionEl ? actionEl.getBoundingClientRect().width : 0,
        endGap: 0.5 * remPx(),
      };
      setMeasures((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next
      );
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(titleSizer);
    ro.observe(sizers);
    if (actionEl) ro.observe(actionEl);
    void document.fonts?.ready.then(() => {
      if (box.isConnected) measure();
    });
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- facts are compared by text (factKey); a new array with the same text needs no new measure
  }, [box, titleSizer, sizers, actionEl, channel, resolution, factKey, title]);

  const plan = planCopy({ ...measures, required });
  const last = plan.lines.length - 1;

  const res = (
    <span className="text-[10px] font-medium text-muted">{resolution}</span>
  );
  const item = (it: CopyItem) =>
    it === "r" ? (
      res
    ) : it === "c" ? (
      renderChannel ? (
        renderChannel("text-gray-400 hover:text-accent")
      ) : (
        <span className="text-gray-400">{channel}</span>
      )
    ) : (
      <span className="text-muted" title={facts[it]?.title}>
        {facts[it]?.text}
      </span>
    );

  return (
    <div ref={boxRef} className={`relative min-h-0 flex-1 p-3 ${className}`}>
      {/* What the card asks of its row: its natural lines. */}
      <div
        aria-hidden
        // A title line is one unit; each details line is its 0.25rem gap plus
        // a 1rem line: also one unit.
        style={{ height: `${plan.naturalUnits * UNIT_REM}rem` }}
      />
      {/* Sizers draw their text from a data attribute (::before), so the
          title and channel are not on the page twice. */}
      <span
        ref={titleSizerRef}
        aria-hidden
        data-text={title}
        className={`pointer-events-none invisible absolute inset-x-3 top-3 -z-10 before:content-[attr(data-text)] ${TITLE_CLASS}`}
      />
      <div
        ref={sizersRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex w-max whitespace-nowrap text-xs leading-4 [&>span]:before:content-[attr(data-text)]"
      >
        {channel ? <span data-sizer="c" data-text={channel} /> : null}
        {facts.map((f, i) => (
          <span key={i} data-sizer={i} data-text={f.text} />
        ))}
        <span data-sizer="sep" data-text={SEP} />
        {resolution ? (
          <span
            data-sizer="r"
            data-text={resolution}
            className="text-[10px] font-medium"
          />
        ) : null}
      </div>
      <div className="absolute inset-3 flex flex-col justify-between gap-1">
        <CardTitle
          text={title}
          truncated={plan.titleLines < measures.titleNeeded}
          className={`overflow-hidden ${TITLE_CLASS}`}
          style={{
            display: "-webkit-box",
            WebkitBoxOrient: "vertical",
            WebkitLineClamp: plan.titleLines,
            height: `${plan.titleLines * UNIT_REM}rem`,
          }}
        />
        {plan.lines.map((line, i) => (
          <div
            key={line.join(",")}
            className="flex h-4 min-w-0 items-center text-xs leading-4"
          >
            <span className="min-w-0 truncate">
              {line.map((it, j) => (
                <Fragment key={String(it)}>
                  {j > 0 ? (
                    <span aria-hidden className="text-muted">
                      {SEP}
                    </span>
                  ) : null}
                  {item(it)}
                </Fragment>
              ))}
            </span>
            {i === last && plan.resTrailing && resolution ? (
              <span className="ml-auto shrink-0 pl-2">{res}</span>
            ) : null}
            {i === last && action ? (
              <span
                ref={actionRef}
                className={`flex shrink-0 items-center pl-2 ${
                  plan.resTrailing && resolution ? "" : "ml-auto"
                }`}
              >
                {action}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
