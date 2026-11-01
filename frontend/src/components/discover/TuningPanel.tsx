import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { useToast } from "../../context/ToastContext";
import { Toggle } from "../../pages/settings/ui";
import {
  useRecTopics,
  useRecTuning,
  useSaveRecTuning,
} from "../../queries/discover";
import { queryKeys } from "../../queries/keys";
import type { DiscoverMix, RecTopic, RecTuning } from "../../types";
import Collapse from "../Collapse";
import { PanelHeader } from "../SidePanelFrame";
import ThemedSelect from "../ThemedSelect";
import TopicsSection from "./TopicsSection";
import { BUCKET_LABEL, BUCKET_TINT, BUCKETS, sharePercents } from "./buckets";

/** Slider moves are saved this long after the last one (the feed re-ranks). */
const SAVE_DELAY_MS = 400;

const CHIP =
  "ui-interactive rounded-full border px-3 py-1 text-xs font-medium transition-colors";
const CHIP_IDLE = `${CHIP} border-ink-700 text-gray-300 hover:border-accent hover:text-accent`;
const CHIP_ON = `${CHIP} border-accent/50 bg-accent/15 text-accent`;
const QUIET_BTN =
  "rounded-md px-2 py-1.5 text-xs text-muted hover:text-accent disabled:opacity-40";

type Updater = (t: RecTuning) => RecTuning;

/** A longest length under the shortest: not saved until the user fixes it. */
function badLengths(t: RecTuning): boolean {
  return t.max_minutes > 0 && t.max_minutes < t.min_minutes;
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
      {children}
    </h3>
  );
}

function SliderRow({
  label,
  tint,
  hint,
  value,
  min,
  max,
  step = 1,
  display,
  ends,
  onChange,
}: {
  label: string;
  /** A swatch tying the slider to its part of the mix bar. */
  tint?: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  ends?: [string, string];
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <label
          htmlFor={id}
          className="flex items-center gap-2 text-sm text-gray-200"
        >
          {tint && (
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${tint}`}
            />
          )}
          {label}
        </label>
        <span className="shrink-0 text-xs tabular-nums text-muted">
          {display}
        </span>
      </div>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {/* Room for the thumb, which is taller than the 4px track. */}
      <div className="py-1.5">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={display}
          onChange={(e) => onChange(Number(e.target.value))}
          className="accent-scrubber accent-scrubber--fill w-full"
          style={
            {
              "--fill": `${((value - min) / (max - min)) * 100}%`,
            } as React.CSSProperties
          }
        />
      </div>
      {ends && (
        <div className="flex justify-between text-[11px] text-muted">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
    </div>
  );
}

function SelectRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-sm text-gray-200">{label}</span>
      <ThemedSelect
        value={value}
        options={options}
        onChange={onChange}
        size="compact"
        align="right"
        buttonClassName="min-w-28"
        aria-label={label}
      />
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>
        <span className="block text-sm text-gray-200">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function MinutesInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-1 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={600}
        value={value || ""}
        placeholder="Any"
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          onChange(Number.isFinite(n) ? Math.min(600, Math.max(0, n)) : 0);
        }}
        className="ui-panel w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-gray-100 outline-hidden focus:border-accent"
      />
    </div>
  );
}

/** The asked-for mix as a bar, and what the feed's top picks really got. */
/** Your interests' share comes first (see ``STRENGTH_SHARE`` in topics.py). */
const INTEREST_SHARE = { low: 0.04, normal: 0.08, high: 0.14 } as const;
const INTEREST_SHARE_CAP = 0.35;
const INTEREST_TINT = "bg-accent-deep";

function interestShare(topics: RecTopic[] | undefined): number {
  const now = Date.now();
  const total = (topics ?? [])
    .filter((t) => t.kind === "interest" && t.active)
    .filter((t) => !t.expires_at || new Date(t.expires_at).getTime() > now)
    .reduce((sum, t) => sum + INTEREST_SHARE[t.strength], 0);
  return Math.min(INTEREST_SHARE_CAP, total);
}

function MixBar({
  shares,
  interest,
  actual,
}: {
  shares: RecTuning["shares"];
  /** Your interests' share (0..1), taken before the rest. */
  interest: number;
  actual: DiscoverMix[] | undefined;
}) {
  const own = sharePercents(shares);
  const segments = [
    ...(interest > 0
      ? [
          {
            id: "interest",
            label: BUCKET_LABEL.interest,
            tint: INTEREST_TINT,
            pct: Math.round(interest * 100),
          },
        ]
      : []),
    ...BUCKETS.map((b) => ({
      id: b.id as string,
      label: b.label,
      tint: BUCKET_TINT[b.id],
      pct: Math.round(own[b.id] * (1 - interest)),
    })),
  ];
  const got = new Map((actual ?? []).map((m) => [m.bucket, m.actual]));
  const short = (actual ?? []).filter((m) => m.target - m.actual > 0.06);
  return (
    <div className="space-y-1.5">
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-ink-800"
        role="img"
        aria-label={`Asked for: ${segments.map((g) => `${g.label} ${g.pct}%`).join(", ")}`}
      >
        {segments.map((g) =>
          g.pct > 0 ? (
            <span
              key={g.id}
              className={g.tint}
              style={{ width: `${g.pct}%` }}
            />
          ) : null
        )}
      </div>
      {actual && actual.length > 0 && (
        <div
          className="flex h-1 w-full overflow-hidden rounded-full bg-ink-800"
          role="img"
          aria-label={`The top of your feed got: ${segments
            .map((g) => `${g.label} ${Math.round((got.get(g.id) ?? 0) * 100)}%`)
            .join(", ")}`}
        >
          {segments.map((g) => {
            const w = Math.round((got.get(g.id) ?? 0) * 100);
            return w > 0 ? (
              <span key={g.id} className={g.tint} style={{ width: `${w}%` }} />
            ) : null;
          })}
        </div>
      )}
      {short.length > 0 && (
        <p className="text-xs text-muted" data-horde="mix-short">
          {short
            .map(
              (m) =>
                `${BUCKET_LABEL[m.bucket] ?? m.bucket}: asked ${Math.round(m.target * 100)}%, got ${Math.round(m.actual * 100)}%`
            )
            .join(" · ")}
          . Not enough close matches; the rest went to the other kinds.
        </p>
      )}
    </div>
  );
}

const pct = (v: number) => `${v}%`;
const lean = (v: number, low: string, high: string, mid = "Default") =>
  v === 50 ? mid : v < 50 ? low : high;

/**
 * The Recommended+ algorithm: presets and every value behind the feed. Shown
 * in the side panel next to the feed and on the Account page; both read and
 * save the same settings, so they always match. Moving anything switches to
 * "Custom" and saves after a short pause; the feed re-ranks on its own.
 */
export default function TuningPanel({
  variant = "panel",
}: {
  variant?: "panel" | "page";
}) {
  const { showError } = useToast();
  const queryClient = useQueryClient();
  const query = useRecTuning();
  const topics = useRecTopics().data?.items;
  const save = useSaveRecTuning();
  const [draft, setDraft] = useState<RecTuning | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const timer = useRef<number | null>(null);
  const pending = useRef<RecTuning | null>(null);
  // The latest feed's mix (DiscoverHome stores it); empty off that page.
  const mix = useQuery<DiscoverMix[]>({
    queryKey: queryKeys.discover.mix,
    queryFn: () => [],
    enabled: false,
    staleTime: Infinity,
  }).data;

  // Leaving with a move not saved yet: save it now.
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      const unsaved = pending.current;
      if (unsaved && !badLengths(unsaved)) {
        void api
          .saveRecTuning({ active: "custom", custom: unsaved })
          .then((saved) =>
            // The feed and the other copy of this panel follow the cache.
            queryClient.setQueryData(queryKeys.discover.tuning, saved)
          )
          .catch(() => undefined);
      }
    },
    [queryClient]
  );

  const state = query.data;
  if (!state) {
    return query.isError ? (
      <p className="px-4 py-3 text-sm text-muted">
        Could not load your Recommended+ settings.
      </p>
    ) : null;
  }
  const values = draft ?? state.values;
  const active = draft ? "custom" : state.active;
  const preset = state.presets.find((p) => p.id === active);

  const flush = (next: RecTuning) => {
    pending.current = null;
    timer.current = null;
    save.mutate(
      { active: "custom", custom: next },
      {
        // Saved, and nothing newer waiting: show the server's copy again.
        onSuccess: () => {
          if (pending.current === null) setDraft(null);
        },
        onError: () => {
          showError("Could not save your Recommended+ settings");
          setDraft(null);
        },
      }
    );
  };

  const change = (update: Updater) => {
    const next = update(values);
    setDraft(next);
    pending.current = next;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = badLengths(next)
      ? null
      : window.setTimeout(() => flush(next), SAVE_DELAY_MS);
  };
  const set = <K extends keyof RecTuning>(key: K, value: RecTuning[K]) =>
    change((t) => ({ ...t, [key]: value }));

  const pick = (id: string) => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    // A move still waiting to be saved is kept as the user's own values.
    const unsaved =
      pending.current && !badLengths(pending.current) ? pending.current : null;
    pending.current = null;
    if (id === "custom") {
      if (unsaved) flush(unsaved);
      else setDraft(null);
      if (unsaved || !state.custom) return;
    }
    setDraft(null);
    save.mutate(
      { active: id, ...(unsaved ? { custom: unsaved } : {}) },
      { onError: () => showError("Could not switch the algorithm") }
    );
  };

  const interest = interestShare(topics);
  const shares = sharePercents(values.shares);
  const strict = values.strictness;
  const strictAll = Math.round(
    (strict.similar + strict.new + strict.throwback) / 3
  );
  const mixedStrictness =
    strict.similar !== strict.new || strict.new !== strict.throwback;

  const body = (
    <div className="space-y-5" data-horde="tuning-panel">
      <section className="space-y-2" aria-label="Presets">
        <div className="flex flex-wrap gap-1.5">
          {state.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={active === p.id}
              onClick={() => pick(p.id)}
              className={active === p.id ? CHIP_ON : CHIP_IDLE}
            >
              {p.name}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={active === "custom"}
            disabled={!state.custom && active !== "custom"}
            onClick={() => pick("custom")}
            title={
              state.custom || active === "custom"
                ? "Your own settings"
                : "Move any setting to make your own"
            }
            className={`${active === "custom" ? CHIP_ON : CHIP_IDLE} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            Custom
          </button>
        </div>
        <p className="text-xs text-muted">
          {preset
            ? preset.description
            : "Your own settings. Pick a preset to start over from it."}
        </p>
      </section>

      <section className="space-y-3" aria-labelledby="tuning-mix">
        <Heading>
          <span id="tuning-mix">Mix</span>
        </Heading>
        <MixBar shares={values.shares} interest={interest} actual={mix} />
        {interest > 0 && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 rounded-full ${INTEREST_TINT}`}
            />
            Your interests take {Math.round(interest * 100)}% first; the rest is
            shared as below.
          </p>
        )}
        {BUCKETS.map((b) => (
          <SliderRow
            key={b.id}
            label={b.label}
            tint={BUCKET_TINT[b.id]}
            hint={b.hint}
            value={values.shares[b.id]}
            min={0}
            max={100}
            display={
              values.shares[b.id] === 0
                ? "Off"
                : pct(Math.round(shares[b.id] * (1 - interest)))
            }
            onChange={(v) =>
              change((t) => ({ ...t, shares: { ...t.shares, [b.id]: v } }))
            }
          />
        ))}
      </section>

      <TopicsSection />

      <section className="space-y-3" aria-labelledby="tuning-ranking">
        <Heading>
          <span id="tuning-ranking">Ranking</span>
        </Heading>
        <SliderRow
          label="Match strictness"
          value={strictAll}
          min={0}
          max={100}
          display={
            mixedStrictness ? "Mixed" : lean(strictAll, "Looser", "Stricter")
          }
          ends={["Take chances", "Close matches only"]}
          onChange={(v) =>
            change((t) => ({
              ...t,
              strictness: { similar: v, new: v, throwback: v },
            }))
          }
        />
        <SliderRow
          label="Freshness"
          value={values.freshness}
          min={0}
          max={100}
          display={lean(values.freshness, "Any age", "Recent")}
          ends={["Any age", "Recent uploads"]}
          onChange={(v) => set("freshness", v)}
        />
        <SliderRow
          label="Popularity"
          value={values.popularity}
          min={-100}
          max={100}
          step={5}
          display={
            values.popularity === 0
              ? "Default"
              : values.popularity < 0
                ? "Hidden gems"
                : "Popular"
          }
          ends={["Hidden gems", "Popular"]}
          onChange={(v) => set("popularity", v)}
        />
        <SliderRow
          label="Shuffle"
          value={values.shuffle}
          min={0}
          max={100}
          display={
            values.shuffle === 0 ? "Off" : lean(values.shuffle, "Less", "More")
          }
          ends={["Same order", "More surprises"]}
          onChange={(v) => set("shuffle", v)}
        />
      </section>

      <section className="space-y-3" aria-labelledby="tuning-variety">
        <Heading>
          <span id="tuning-variety">Variety and repeats</span>
        </Heading>
        <SliderRow
          label="Same channel at most once every"
          value={values.channel_gap}
          min={1}
          max={12}
          display={
            values.channel_gap === 1
              ? "No limit"
              : `${values.channel_gap} videos`
          }
          onChange={(v) => set("channel_gap", v)}
        />
        <SliderRow
          label="Videos per new channel"
          value={values.new_channel_cap}
          min={1}
          max={6}
          display={String(values.new_channel_cap)}
          onChange={(v) => set("new_channel_cap", v)}
        />
        <SelectRow
          label="Drop a video shown without a watch after"
          value={String(values.worn_after)}
          options={[
            { value: "3", label: "3 visits" },
            { value: "6", label: "6 visits" },
            { value: "12", label: "12 visits" },
            { value: "0", label: "Never" },
          ]}
          onChange={(v) =>
            set("worn_after", Number(v) as RecTuning["worn_after"])
          }
        />
      </section>

      <section className="space-y-3" aria-labelledby="tuning-taste">
        <Heading>
          <span id="tuning-taste">Your taste</span>
        </Heading>
        <SelectRow
          label="Recent taste is the last"
          value={String(values.recent_days)}
          options={[
            { value: "14", label: "2 weeks" },
            { value: "30", label: "Month" },
            { value: "60", label: "2 months" },
            { value: "90", label: "3 months" },
          ]}
          onChange={(v) =>
            set("recent_days", Number(v) as RecTuning["recent_days"])
          }
        />
        <SelectRow
          label="Throwbacks reach back"
          value={String(values.throwback_years)}
          options={[
            { value: "1", label: "1 year" },
            { value: "3", label: "3 years" },
            { value: "0", label: "All time" },
          ]}
          onChange={(v) =>
            set("throwback_years", Number(v) as RecTuning["throwback_years"])
          }
        />
      </section>

      <section className="space-y-3" aria-labelledby="tuning-filters">
        <Heading>
          <span id="tuning-filters">Filters</span>
        </Heading>
        <ToggleRow
          label="Hide Shorts"
          hint="A minute or less, or a /shorts/ link."
          checked={values.hide_shorts}
          onChange={() => set("hide_shorts", !values.hide_shorts)}
        />
        <ToggleRow
          label="Hide past live streams"
          checked={values.hide_past_live}
          onChange={() => set("hide_past_live", !values.hide_past_live)}
        />
        <div className="flex gap-3">
          <MinutesInput
            label="Shortest (minutes)"
            value={values.min_minutes}
            onChange={(v) => set("min_minutes", v)}
          />
          <MinutesInput
            label="Longest (minutes)"
            value={values.max_minutes}
            onChange={(v) => set("max_minutes", v)}
          />
        </div>
        {badLengths(values) && (
          <p role="alert" className="text-xs text-warning">
            The longest is shorter than the shortest; this is not saved until
            you fix it.
          </p>
        )}
        <SelectRow
          label="Uploaded within"
          value={String(values.max_age_days)}
          options={[
            { value: "0", label: "Any time" },
            { value: "7", label: "A week" },
            { value: "30", label: "A month" },
            { value: "90", label: "3 months" },
            { value: "365", label: "A year" },
            { value: "1095", label: "3 years" },
          ]}
          onChange={(v) =>
            set("max_age_days", Number(v) as RecTuning["max_age_days"])
          }
        />
      </section>

      <section className="space-y-3" aria-labelledby="tuning-sources">
        <Heading>
          <span id="tuning-sources">Sources</span>
        </Heading>
        <ToggleRow
          label="Your library"
          checked={values.use_library}
          onChange={() => set("use_library", !values.use_library)}
        />
        <ToggleRow
          label="Indexed channels"
          checked={values.use_catalogs}
          onChange={() => set("use_catalogs", !values.use_catalogs)}
        />
        <ToggleRow
          label="Found on YouTube"
          hint="Off also stops Horde searching YouTube for you."
          checked={values.use_youtube}
          onChange={() => set("use_youtube", !values.use_youtube)}
        />
        <ToggleRow
          label="Liked by people here"
          hint="A small lift for videos others with similar taste liked."
          checked={values.use_household}
          onChange={() => set("use_household", !values.use_household)}
        />
      </section>

      <section className="space-y-3">
        <button
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced((v) => !v)}
          className="flex w-full items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-gray-400 hover:text-accent"
        >
          Advanced
          <span
            aria-hidden="true"
            className={`transition-transform duration-200 ${advanced ? "rotate-90" : ""}`}
          >
            ›
          </span>
        </button>
        <Collapse open={advanced}>
          <div className="space-y-3 pt-1">
            {BUCKETS.filter((b) => b.id in strict).map((b) => (
              <SliderRow
                key={b.id}
                label={`Strictness: ${b.label.toLowerCase()}`}
                value={strict[b.id as keyof typeof strict]}
                min={0}
                max={100}
                display={lean(
                  strict[b.id as keyof typeof strict],
                  "Looser",
                  "Stricter"
                )}
                onChange={(v) =>
                  change((t) => ({
                    ...t,
                    strictness: { ...t.strictness, [b.id]: v },
                  }))
                }
              />
            ))}
            <SliderRow
              label="Watched at least this much to count"
              hint="Videos you left earlier stop shaping your recommendations. Imported YouTube history always counts."
              value={values.min_watched_pct}
              min={0}
              max={90}
              step={5}
              display={
                values.min_watched_pct === 0
                  ? "Any"
                  : pct(values.min_watched_pct)
              }
              onChange={(v) => set("min_watched_pct", v)}
            />
            <SelectRow
              label="Rewatch once it is at least"
              value={String(values.rewatch_after_days)}
              options={[
                { value: "30", label: "A month old" },
                { value: "60", label: "2 months old" },
                { value: "180", label: "6 months old" },
                { value: "365", label: "A year old" },
              ]}
              onChange={(v) =>
                set(
                  "rewatch_after_days",
                  Number(v) as RecTuning["rewatch_after_days"]
                )
              }
            />
            <SliderRow
              label="Prefer downloaded videos"
              value={values.library_boost}
              min={0}
              max={100}
              step={5}
              display={
                values.library_boost === 0 ? "No" : pct(values.library_boost)
              }
              onChange={(v) => set("library_boost", v)}
            />
            <p className="text-xs text-muted">
              To remove a watch, or stop one from shaping recommendations, edit{" "}
              <Link to="/history" className="text-accent hover:underline">
                your history
              </Link>
              .
            </p>
          </div>
        </Collapse>
      </section>
    </div>
  );

  const reset = (
    <button
      type="button"
      onClick={() => pick("balanced")}
      disabled={active === "balanced"}
      className={QUIET_BTN}
    >
      Reset
    </button>
  );

  if (variant === "page") {
    return (
      <div className="space-y-3">
        <div className="flex justify-end">{reset}</div>
        {body}
      </div>
    );
  }
  return (
    <>
      <PanelHeader title="Recommended+ algorithm" actions={reset} />
      <div
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-focusable (axe scrollable-region-focusable)
        tabIndex={0}
        aria-label="Recommended+ algorithm"
        className="horde-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        {body}
      </div>
    </>
  );
}
