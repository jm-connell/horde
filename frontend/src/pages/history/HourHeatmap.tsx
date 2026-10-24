import { useId, useState, type KeyboardEvent } from "react";
import {
  chartKeyStep,
  formatWatchTime,
  formatWatchTimeLong,
  heatLevel,
  hourLabel,
  WEEKDAYS,
} from "./statsFormat";
import { ChartTooltip } from "./WatchTimeChart";

/** One accent hue, light to strong: nothing, then four steps up to the busiest hour. */
const HEAT_CLASSES = [
  "bg-ink-800",
  "bg-accent/25",
  "bg-accent/45",
  "bg-accent/70",
  "bg-accent",
];

const LABEL_HOURS = [0, 6, 12, 18];

function cellLabel(day: number, hour: number): string {
  return `${WEEKDAYS[day]}, ${hourLabel(hour)} to ${hourLabel((hour + 1) % 24)}`;
}

/**
 * When the viewer watches: seconds by weekday (rows, Monday first) and hour of
 * the day (columns). Arrow keys move between cells, like the bar chart.
 */
export default function HourHeatmap({ hours }: { hours: number[][] }) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(0, ...hours.flat());
  let busiest = 0;
  hours.flat().forEach((v, i, all) => {
    if (v > all[busiest]) busiest = i;
  });
  const busiestDay = Math.floor(busiest / 24);
  const busiestHour = busiest % 24;
  const summary =
    max > 0
      ? `When you watch, by weekday and hour. Busiest: ${cellLabel(busiestDay, busiestHour)}, ${formatWatchTimeLong(max)}. Use the arrow keys to read each hour.`
      : "When you watch, by weekday and hour: nothing yet.";

  const move = (to: number) => setActive(Math.max(0, Math.min(7 * 24 - 1, to)));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = chartKeyStep(e.key, 24);
    if (step !== null) move((active ?? busiest) + step);
    else if (e.key === "Home") move(Math.floor((active ?? 0) / 24) * 24);
    else if (e.key === "End") move(Math.floor((active ?? 0) / 24) * 24 + 23);
    else return;
    e.preventDefault();
  };

  const activeDay = active !== null ? Math.floor(active / 24) : 0;
  const activeHour = active !== null ? active % 24 : 0;
  const activeSeconds = active !== null ? hours[activeDay][activeHour] : 0;
  return (
    <div>
      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="flex w-9 shrink-0 flex-col gap-[2px] text-[10px] leading-none text-muted"
        >
          {WEEKDAYS.map((d) => (
            <span key={d} className="flex h-4 items-center justify-end sm:h-5">
              {d.slice(0, 3)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            role="listbox"
            tabIndex={0}
            aria-label={summary}
            aria-activedescendant={
              active !== null ? `${id}-cell-${active}` : undefined
            }
            onKeyDown={onKeyDown}
            onFocus={() => setActive((a) => a ?? busiest)}
            onBlur={() => setActive(null)}
            onPointerLeave={(e) => {
              // Keyboard reading goes on where the pointer left it.
              if (document.activeElement !== e.currentTarget) setActive(null);
            }}
            className="grid grid-rows-7 gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}
          >
            {hours.map((row, day) =>
              row.map((seconds, hour) => {
                const index = day * 24 + hour;
                return (
                  <div
                    key={index}
                    id={`${id}-cell-${index}`}
                    role="option"
                    aria-selected={index === active}
                    aria-label={`${cellLabel(day, hour)}: ${formatWatchTimeLong(seconds)}`}
                    onPointerEnter={() => setActive(index)}
                    className={`h-4 rounded-[3px] sm:h-5 ${
                      HEAT_CLASSES[heatLevel(seconds, max)]
                    } ${index === active ? "ring-2 ring-gray-100/80" : ""}`}
                  />
                );
              })
            )}
          </div>
          {active !== null && (
            <div
              className="pointer-events-none absolute inset-x-0"
              style={{ top: `${(activeDay / 7) * 100}%` }}
            >
              <ChartTooltip
                leftPct={((activeHour + 0.5) / 24) * 100}
                value={formatWatchTime(activeSeconds)}
                label={cellLabel(activeDay, activeHour)}
              />
            </div>
          )}
          <div
            aria-hidden="true"
            className="relative mt-1.5 h-3 text-[10px] leading-none text-muted"
          >
            {LABEL_HOURS.map((h) => (
              <span
                key={h}
                className="absolute"
                style={{ left: `${(h / 24) * 100}%` }}
              >
                {hourLabel(h)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div
        aria-hidden="true"
        className="mt-3 flex items-center justify-end gap-1 text-[10px] text-muted"
      >
        <span className="mr-1">Less</span>
        {HEAT_CLASSES.map((c) => (
          <span key={c} className={`h-2.5 w-2.5 rounded-[2px] ${c}`} />
        ))}
        <span className="ml-1">More</span>
      </div>
    </div>
  );
}
