import BackgroundSection from "./appearance/BackgroundSection";
import FontSection from "./appearance/FontSection";
import MotionSection from "./appearance/MotionSection";
import NavBarSection from "./appearance/NavBarSection";
import PanelsSection from "./appearance/PanelsSection";
import TabBarSection from "./appearance/TabBarSection";
import ThemeSection from "./appearance/ThemeSection";
import { CHIP } from "./constants";
import { useSettingsPage } from "./context";
import CustomCssSection from "./CustomCssSection";
import { useAppearanceState } from "./useAppearanceState";

/** The tab's sections, in page order, by their `data-setting` anchor. */
const SECTIONS = [
  { anchor: "theme", label: "Theme" },
  { anchor: "font-section", label: "Font and size" },
  { anchor: "background", label: "Background" },
  { anchor: "motion", label: "Motion" },
  { anchor: "panels", label: "Panels" },
  { anchor: "nav-bar", label: "Top bar" },
  { anchor: "tab-bar", label: "Tab bar" },
  { anchor: "custom-css", label: "Custom CSS" },
] as const;

/** Room for the fixed top bar above a section scrolled to. */
const TOP_BAR_ROOM = 88;

function jumpTo(anchor: string) {
  const el = document.querySelector<HTMLElement>(`[data-setting="${anchor}"]`);
  if (!el) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({
    top: el.getBoundingClientRect().top + window.scrollY - TOP_BAR_ROOM,
    behavior: reduced ? "auto" : "smooth",
  });
  // Keyboard users carry on from the section, not from the jump row.
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export default function AppearanceTab() {
  const appearance = useAppearanceState();
  const { q } = useSettingsPage();

  return (
    <>
      {/* A search already narrows the page to what matched. */}
      {!q && (
        <nav aria-label="Appearance sections" className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.anchor}
              // A real link to the section, for a new tab or a copied URL.
              href={`/settings?tab=appearance&find=${s.anchor}`}
              onClick={(e) => {
                // Leave open-in-new-tab and friends to the browser.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                jumpTo(s.anchor);
              }}
              className={CHIP}
            >
              {s.label}
            </a>
          ))}
        </nav>
      )}
      <ThemeSection appearance={appearance} />
      <FontSection appearance={appearance} />
      <BackgroundSection appearance={appearance} />
      <MotionSection appearance={appearance} />
      <PanelsSection />
      <NavBarSection />
      <TabBarSection />
      <CustomCssSection />
    </>
  );
}
