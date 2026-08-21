import {
  CSS_SELECTORS,
  CSS_VARIABLES,
  CUSTOM_CSS_MAX_CHARS,
  CUSTOM_CSS_PLACEHOLDER,
} from "../../customCss";
import { PANEL_BTN } from "./constants";
import { Section } from "./ui";
import { useSettingsPage } from "./context";

export default function CustomCssSection() {
  const { q, match, settings, update } = useSettingsPage();
  const length = settings.customCss.length;

  return (
    <Section
      title="Custom CSS"
      description="Paste CSS to restyle Horde on top of the current palette. Changes apply immediately and sync with this server."
      hidden={
        !!q &&
        !match(
          "custom css",
          "css",
          "stylesheet",
          "selector",
          "theme css",
          "jellyfin"
        )
      }
    >
      <div className="space-y-3">
        <textarea
          value={settings.customCss}
          onChange={(e) => update({ customCss: e.target.value })}
          spellCheck={false}
          wrap="off"
          rows={14}
          maxLength={CUSTOM_CSS_MAX_CHARS}
          placeholder={CUSTOM_CSS_PLACEHOLDER}
          aria-label="Custom CSS"
          className="horde-scrollbar ui-panel w-full min-h-[16rem] resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-100 outline-none focus:border-accent"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs tabular-nums text-gray-500">
            {length.toLocaleString()} / {CUSTOM_CSS_MAX_CHARS.toLocaleString()}
          </p>
          <button
            type="button"
            className={PANEL_BTN}
            disabled={!settings.customCss}
            onClick={() => update({ customCss: "" })}
          >
            Clear
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Prefer CSS variables and{" "}
          <span className="font-mono text-gray-400">data-horde</span> /{" "}
          <span className="font-mono text-gray-400">data-page</span> hooks
          over one-off Tailwind class names — those can change between
          versions. Variables are space-separated RGB, e.g.{" "}
          <span className="font-mono text-gray-400">--accent: 255 120 40;</span>
          . Included when you save a theme.
        </p>
        <details className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-2">
          <summary className="cursor-pointer text-sm text-gray-300 hover:text-gray-100">
            Selector reference
          </summary>
          <div className="mt-3 space-y-4 text-xs text-gray-400">
            <p>
              This is a short, stable catalog — not a dump of every DOM node.
              Inspect the running page for one-off targeting. Full notes:{" "}
              <a
                href="/wiki/settings/custom-css/"
                className="text-accent hover:underline"
              >
                Custom CSS wiki
              </a>
              .
            </p>
            <div>
              <p className="mb-1 font-medium uppercase tracking-wide text-gray-500">
                Variables
              </p>
              <ul className="space-y-1">
                {CSS_VARIABLES.map((row) => (
                  <li key={row.selector}>
                    <code className="text-gray-300">{row.selector}</code>
                    <span className="text-gray-600"> — </span>
                    {row.meaning}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium uppercase tracking-wide text-gray-500">
                Selectors
              </p>
              <ul className="space-y-1">
                {CSS_SELECTORS.map((row) => (
                  <li key={row.selector}>
                    <code className="text-gray-300">{row.selector}</code>
                    <span className="text-gray-600"> — </span>
                    {row.meaning}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </details>
      </div>
    </Section>
  );
}
