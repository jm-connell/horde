import { useId, useMemo, useState, type KeyboardEvent } from "react";
import {
  axisTicks,
  barLabel,
  chartKeyStep,
  formatWatchTime,
  formatWatchTimeLong,
  type ChartBar,
} from "./statsFormat";

/** A floating readout above a mark: the value first, then what it is. */
export function ChartTooltip({
  leftPct,
  bottom = "calc(100% + 6px)",
  value,
  label,
  detail,
}: {
  leftPct: number;
  /** CSS `bottom` of the readout: just above the mark it describes. */
  bottom?: string;
  value: string;
  label: string;
  detail?: string | null;
}) {
  const shift = leftPct < 12 ? "0%" : leftPct > 88 ? "-100%" : "-50%";
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 whitespace-nowrap rounded-lg border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left: `${leftPct}%`, bottom, transform: `translateX(${shift})` }}
    >
      <div className="font-semibold text-gray-100">{value}</div>
      <div className="text-muted">{label}</div>
      {detail && <div className="text-muted">{detail}</div>}
    </div>
  );
}

function finishedText(n: number): string | null {
  return n > 0 ? `${n} finished` : null;
}

/**
 * Watch time per day (or per week for long ranges) as columns. Keyboard: focus
 * the chart, then Left / Right read one bar at a time (a listbox, so screen
 * readers announce each bar); the pointer shows the same readout.
 */
export default function WatchTimeChart({
  bars,
  unit,
}: {
  bars: ChartBar[];
  /** What one bar covers. */
  unit: "day" | "week" | "month";
}) {
  const id = useId();
  const [active, setActive] = useState<number | null>(null);
  const max = useMemo(() => Math.max(0, ...bars.map((b) => b.seconds)), [bars]);
  const ticks = axisTicks(max);
  const top = Math.max(max, ticks[ticks.length - 1] ?? 0);
  const total = bars.reduce((t, b) => t + b.seconds, 0);
  const busiest = bars.reduce<ChartBar | null>(
    (best, b) => (b.seconds > (best?.seconds ?? 0) ? b : best),
    null
  );
  const summary =
    `Watch time per ${unit}, ${formatWatchTimeLong(total)} in all` +
    (busiest
      ? `; most ${barLabel(busiest)}, ${formatWatchTimeLong(busiest.seconds)}`
      : "") +
    ". Use the arrow keys to read each bar.";

  const move = (to: number) =>
    setActive(Math.max(0, Math.min(bars.length - 1, to)));
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = chartKeyStep(e.key, 1);
    if (step !== null) move((active ?? bars.length - 1) + step);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(bars.length - 1);
    else return;
    e.preventDefault();
  };

  const current = active !== null ? bars[active] : null;
  const first = bars[0];
  const last = bars[bars.length - 1];
  return (
    <div>
      <div className="flex gap-2">
        <div aria-hidden="true" className="relative h-40 w-9 shrink-0">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 translate-y-1/2 text-[10px] tabular-nums text-muted"
              style={{ bottom: `${(t / top) * 100}%` }}
            >
              {formatWatchTime(t)}
            </span>
          ))}
        </div>
        <div className="relative h-40 min-w-0 flex-1">
          <div aria-hidden="true" className="absolute inset-0">
            {ticks.map((t) => (
              <div
                key={t}
                className="absolute inset-x-0 border-t border-ink-700/70"
                style={{ bottom: `${(t / top) * 100}%` }}
              />
            ))}
            <div className="absolute inset-x-0 bottom-0 border-t border-ink-600" />
          </div>
          <div
            role="listbox"
            tabIndex={0}
            aria-label={summary}
            aria-activedescendant={
              active !== null ? `${id}-bar-${active}` : undefined
            }
            onKeyDown={onKeyDown}
            onFocus={() => setActive((a) => a ?? bars.length - 1)}
            onBlur={() => setActive(null)}
            onPointerMove={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const i = Math.floor(
                ((e.clientX - box.left) / box.width) * bars.length
              );
              move(i);
            }}
            onPointerLeave={(e) => {
              // Keyboard reading goes on where the pointer left it.
              if (document.activeElement !== e.currentTarget) setActive(null);
            }}
            className="absolute inset-0 flex items-end gap-[2px] rounded outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            {bars.map((bar, i) => (
              <div
                key={bar.key}
                id={`${id}-bar-${i}`}
                role="option"
                aria-selected={i === active}
                aria-label={`${barLabel(bar)}: ${formatWatchTimeLong(bar.seconds)}${
                  bar.finished ? `, ${bar.finished} finished` : ""
                }`}
                className="flex h-full min-w-0 flex-1 items-end justify-center"
              >
                {bar.seconds > 0 && (
                  <div
                    className={`w-[70%] max-w-6 rounded-t-[4px] transition-colors ${
                      i === active ? "bg-accent" : "bg-accent/70"
                    }`}
                    style={{
                      height: `max(2px, ${(bar.seconds / top) * 100}%)`,
                    }}
                  />
                )}
              </div>
            ))}
          </div>
          {current && active !== null && (
            <ChartTooltip
              leftPct={((active + 0.5) / bars.length) * 100}
              bottom={`calc(${(current.seconds / top) * 100}% + 6px)`}
              value={formatWatchTime(current.seconds)}
              label={barLabel(current)}
              detail={finishedText(current.finished)}
            />
          )}
        </div>
      </div>
      {first && (
        <div
          aria-hidden="true"
          className="ml-11 mt-1.5 flex justify-between text-[11px] text-muted"
        >
          <span>{barLabel(first)}</span>
          <span>{unit === "day" ? "Today" : barLabel(last)}</span>
        </div>
      )}
    </div>
  );
}
