import {
  LOADING_STYLE_OPTIONS,
  LOADING_STYLE_SEARCH_KEYWORDS,
} from "../../../loadingStyles";
import LiquidNav from "../../../components/LiquidNav";
import { LoadingMark } from "../../../components/LoadingIndicator";
import { HOVER_MOTION_OPTIONS, NAV_INDICATOR_OPTIONS } from "../constants";
import { Chip, Section } from "../ui";
import { useSettingsPage } from "../context";
import type { AppearanceState } from "../useAppearanceState";

export default function MotionSection({
  appearance,
}: {
  appearance: AppearanceState;
}) {
  const { q, match, settings, update } = useSettingsPage();
  const { navPreview, setNavPreview } = appearance;
  const selectedLoading = LOADING_STYLE_OPTIONS.find(
    (o) => o.value === settings.loadingStyle
  );

  return (
    <Section
      anchor="motion"
      title="Motion"
      hidden={
        !!q &&
        !match(
          "interface motion",
          "ui",
          "navigation indicator",
          "nav",
          "liquid",
          "jelly",
          "underline",
          "fade",
          "dot",
          "focus",
          "glow",
          "lift",
          "hover motion",
          "loading animation",
          LOADING_STYLE_SEARCH_KEYWORDS
        )
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div
            data-setting="nav-indicator"
            className={`min-w-0 flex-1 ${
              match(
                "navigation indicator",
                "nav",
                "liquid",
                "jelly",
                "underline",
                "fade",
                "dot",
                "focus"
              )
                ? ""
                : q
                  ? "hidden"
                  : ""
            }`}
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Navigation indicator
            </p>
            <div className="flex flex-wrap gap-2">
              {NAV_INDICATOR_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.navIndicator === opt.value}
                  onClick={() => update({ navIndicator: opt.value })}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {
                NAV_INDICATOR_OPTIONS.find(
                  (o) => o.value === settings.navIndicator
                )?.description
              }
            </p>
            <LiquidNav
              className="ui-panel mt-3 inline-flex w-fit gap-1 rounded-xl bg-ink-950 p-1 ring-1 ring-ink-700"
              pillClassName="bg-ink-800"
              dependency={navPreview}
            >
              {(
                [
                  { id: "home", label: "Home" },
                  { id: "library", label: "Library" },
                  { id: "settings", label: "Settings" },
                ] as const
              ).map((item) => (
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

          <div
            data-setting="hover-motion"
            className={`min-w-0 flex-1 ${
              match("hover motion", "cards", "controls", "glow", "lift")
                ? ""
                : q
                  ? "hidden"
                  : ""
            }`}
          >
            <p className="mb-2 text-sm font-medium text-gray-200">
              Hover motion
            </p>
            <div className="flex flex-wrap gap-2">
              {HOVER_MOTION_OPTIONS.map((opt) => (
                <Chip
                  key={opt.value}
                  active={settings.hoverMotion === opt.value}
                  onClick={() => update({ hoverMotion: opt.value })}
                >
                  {opt.label}
                </Chip>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">
              {
                HOVER_MOTION_OPTIONS.find(
                  (o) => o.value === settings.hoverMotion
                )?.description
              }
            </p>
          </div>
        </div>

        <div
          data-setting="loading-style"
          className={
            match("loading animation", LOADING_STYLE_SEARCH_KEYWORDS)
              ? undefined
              : q
                ? "hidden"
                : undefined
          }
        >
          <span className="mb-2 block text-sm font-medium text-gray-200">
            Loading animation
          </span>
          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="Loading animation"
          >
            {LOADING_STYLE_OPTIONS.map((opt) => (
              <Chip
                key={opt.value}
                active={settings.loadingStyle === opt.value}
                onClick={() => update({ loadingStyle: opt.value })}
                title={`${opt.label} — ${opt.description}`}
                aria-label={opt.label}
                className="flex h-20 w-20 shrink-0 items-center justify-center overflow-visible px-1.5! py-1.5!"
              >
                <LoadingMark style={opt.value} compact />
              </Chip>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            {selectedLoading
              ? `${selectedLoading.label} — ${selectedLoading.description}`
              : null}
          </p>
        </div>
      </div>
    </Section>
  );
}
