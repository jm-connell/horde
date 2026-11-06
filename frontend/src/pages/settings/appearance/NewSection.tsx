import { useState } from "react";
import {
  BACKGROUND_EFFECT_OPTIONS,
  NEW_BACKGROUND_EFFECT_OPTIONS,
} from "../../../effects";
import LiquidNav from "../../../components/LiquidNav";
import { LoadingMark } from "../../../components/LoadingIndicator";
import { button } from "../../../components/buttons";
import type { BackgroundEffect } from "../../../hooks/useSettings";
import { NEW_LOADING_STYLE_OPTIONS } from "../../../loadingStyles";
import {
  NEW_HOVER_MOTION_OPTIONS,
  NEW_NAV_INDICATOR_OPTIONS,
} from "../constants";
import { useSettingsPage } from "../context";
import { NEW_SECTION_KEYWORDS } from "../search";
import { Chip, Section } from "../ui";

const NAV_PREVIEW = [
  { id: "home", label: "Home" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
] as const;

function effectLabel(value: BackgroundEffect | undefined): string | undefined {
  return BACKGROUND_EFFECT_OPTIONS.find((o) => o.value === value)?.label;
}

/**
 * Reworked and new backgrounds, loaders and motion, kept apart from the
 * established options so they can be tried side by side. Picking one sets
 * the same setting the usual pickers do.
 */
export default function NewSection() {
  const { q, match, settings, update } = useSettingsPage();
  const [navPreview, setNavPreview] =
    useState<(typeof NAV_PREVIEW)[number]["id"]>("library");
  // The new background being compared with the one it reworks.
  const [comparing, setComparing] = useState<BackgroundEffect | null>(null);

  const background = NEW_BACKGROUND_EFFECT_OPTIONS.find(
    (o) => o.value === settings.backgroundEffect
  );
  const compared = NEW_BACKGROUND_EFFECT_OPTIONS.find(
    (o) => o.value === comparing && o.reworks === settings.backgroundEffect
  );
  const loader = NEW_LOADING_STYLE_OPTIONS.find(
    (o) => o.value === settings.loadingStyle
  );
  const nav = NEW_NAV_INDICATOR_OPTIONS.find(
    (o) => o.value === settings.navIndicator
  );
  const hover = NEW_HOVER_MOTION_OPTIONS.find(
    (o) => o.value === settings.hoverMotion
  );
  const original = effectLabel(background?.reworks);

  return (
    <Section
      anchor="new"
      title="New"
      description="Reworked and new backgrounds, loaders and motion to try. Picking one applies it like any other choice; the existing options stay where they are."
      hidden={!!q && !match(NEW_SECTION_KEYWORDS)}
    >
      <div className="flex flex-col gap-6">
        <div>
          <p className="mb-2 text-sm font-medium text-gray-200">
            Background animation
          </p>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-3"
            role="group"
            aria-label="New backgrounds"
          >
            {NEW_BACKGROUND_EFFECT_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                active={settings.backgroundEffect === o.value}
                onClick={() => {
                  setComparing(null);
                  update({ backgroundEffect: o.value });
                }}
                className="flex flex-col items-start gap-0.5 text-left"
              >
                <span>{o.label}</span>
                <span className="text-xs font-normal text-muted">
                  {o.description}
                </span>
                {o.reworks && (
                  <span className="text-xs font-normal text-muted">
                    Rework of {effectLabel(o.reworks)}
                  </span>
                )}
              </Chip>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-xs text-muted">
              Intensity, speed, size and color are under Background, below.
            </p>
            {/* One button that flips between the two, so focus stays on it. */}
            {((background?.reworks && original) || compared) && (
              <button
                type="button"
                onClick={() => {
                  if (compared) {
                    setComparing(null);
                    update({ backgroundEffect: compared.value });
                  } else if (background?.reworks) {
                    setComparing(background.value);
                    update({ backgroundEffect: background.reworks });
                  }
                }}
                className={button("quiet", "xs")}
              >
                {compared
                  ? `Back to ${compared.label}`
                  : `Compare with ${original}`}
              </button>
            )}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-gray-200">
            Loading animation
          </p>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="New loaders"
          >
            {NEW_LOADING_STYLE_OPTIONS.map((o) => (
              <Chip
                key={o.value}
                active={settings.loadingStyle === o.value}
                onClick={() => update({ loadingStyle: o.value })}
                title={`${o.label} — ${o.description}`}
                aria-label={o.label}
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-visible px-1.5! py-1.5!"
              >
                <LoadingMark style={o.value} compact />
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {loader
              ? `${loader.label} — ${loader.description}${
                  loader.reworks ? ` (rework of ${loader.reworks})` : ""
                }`
              : "These move only by transform and opacity, so they keep their pace while a page is busy."}
          </p>
        </div>

        <div className="flex flex-col gap-6 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-sm font-medium text-gray-200">
              Navigation indicator
            </p>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="New navigation indicators"
            >
              {NEW_NAV_INDICATOR_OPTIONS.map((o) => (
                <Chip
                  key={o.value}
                  active={settings.navIndicator === o.value}
                  onClick={() => update({ navIndicator: o.value })}
                >
                  {o.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {nav
                ? `${nav.description}${nav.reworks ? ` (rework of ${nav.reworks})` : ""}`
                : "Pick one, then switch between the items below."}
            </p>
            <LiquidNav
              className="ui-panel mt-3 inline-flex w-fit gap-1 rounded-xl bg-ink-950 p-1 ring-1 ring-ink-700"
              pillClassName="bg-ink-800"
              dependency={navPreview}
            >
              {NAV_PREVIEW.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-liquid-active={
                    navPreview === item.id ? "true" : undefined
                  }
                  onClick={() => setNavPreview(item.id)}
                  className={`ui-interactive relative z-10 shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    navPreview === item.id
                      ? settings.navIndicator !== "none"
                        ? "text-gray-100"
                        : "bg-ink-800 text-gray-100"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </LiquidNav>
          </div>

          <div className="min-w-0 flex-1">
            <p className="mb-2 text-sm font-medium text-gray-200">
              Hover motion
            </p>
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="New hover motions"
            >
              {NEW_HOVER_MOTION_OPTIONS.map((o) => (
                <Chip
                  key={o.value}
                  active={settings.hoverMotion === o.value}
                  onClick={() => update({ hoverMotion: o.value })}
                >
                  {o.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {hover
                ? hover.description
                : "Pick one, then point at the card below (mouse or trackpad)."}
            </p>
            <SampleCard />
          </div>
        </div>
      </div>
    </Section>
  );
}

/** A stand-in video card to try hover motion on. */
function SampleCard() {
  return (
    <div
      data-horde="card-sample"
      aria-hidden
      className="ui-card mt-3 w-60 max-w-full overflow-hidden rounded-xl bg-ink-900 ring-1 ring-ink-700 transition-colors hover:ring-accent/60"
    >
      <div className="ui-card-media relative aspect-video w-full overflow-hidden bg-ink-800">
        <div
          className="ui-card-art absolute inset-0"
          style={{
            background: [
              "radial-gradient(circle at 70% 36%, rgb(var(--accent) / 0.9) 0 7%, rgb(var(--accent) / 0.22) 8%, transparent 26%)",
              "linear-gradient(168deg, transparent 58%, rgb(var(--ink-950)) 58.5%)",
              "linear-gradient(196deg, transparent 66%, rgb(var(--ink-900)) 66.5%)",
              "linear-gradient(to bottom, rgb(var(--accent) / 0.32), rgb(var(--ink-800)))",
            ].join(", "),
          }}
        />
        <span className="pointer-events-none absolute bottom-2 right-2 z-10 rounded bg-black/80 px-1.5 py-0.5 text-xs font-medium text-white">
          12:34
        </span>
      </div>
      <div className="space-y-0.5 p-3">
        <p className="text-sm font-medium text-gray-100">A sample video</p>
        <p className="text-xs text-muted">Sample channel · 2 days ago</p>
      </div>
    </div>
  );
}
