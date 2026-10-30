import Collapse from "../../components/Collapse";
import { useHelpChat } from "../../context/HelpChatContext";
import {
  CSS_SELECTORS,
  CSS_VARIABLES,
  CUSTOM_CSS_MAX_CHARS,
  CUSTOM_CSS_PLACEHOLDER,
} from "../../customCss";
import { PANEL_BTN } from "./constants";
import { Section, Toggle } from "./ui";
import { useSettingsPage } from "./context";

export default function CustomCssSection() {
  const { q, match, settings, update } = useSettingsPage();
  const helpChat = useHelpChat();
  const length = settings.customCss.length;

  return (
    <Section
      anchor="custom-css"
      title="Custom CSS"
      action={
        <Toggle
          label="Enable custom CSS"
          checked={settings.customCssEnabled}
          onChange={() =>
            update({ customCssEnabled: !settings.customCssEnabled })
          }
        />
      }
      hidden={
        !!q &&
        !match(
          "custom css",
          "css",
          "stylesheet",
          "selector",
          "theme css",
          "jellyfin",
          "enable custom css",
          "nocss"
        )
      }
    >
      <p className="mt-2 text-xs text-muted">
        Not a CSS person?{" "}
        {helpChat.available ? (
          <button
            type="button"
            className="text-accent underline underline-offset-2"
            onClick={() => helpChat.setOpen(true)}
          >
            Ask about Horde
          </button>
        ) : (
          "Ask about Horde"
        )}{" "}
        writes it for you: describe the change, preview it on the page, then
        keep or revert it. If a stylesheet ever hides the page, open Horde in a
        browser tab with <span className="font-mono text-gray-400">?nocss</span>{" "}
        on the address to load it without your CSS.
      </p>
      <Collapse open={settings.customCssEnabled}>
        <div className="space-y-3 pt-4">
          <textarea
            value={settings.customCss}
            onChange={(e) => update({ customCss: e.target.value })}
            spellCheck={false}
            wrap="off"
            rows={14}
            maxLength={CUSTOM_CSS_MAX_CHARS}
            placeholder={CUSTOM_CSS_PLACEHOLDER}
            aria-label="Custom CSS"
            className="horde-scrollbar ui-panel w-full min-h-64 resize-y rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[13px] leading-relaxed text-gray-100 outline-hidden focus:border-accent"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs tabular-nums text-muted">
              {length.toLocaleString()} /{" "}
              {CUSTOM_CSS_MAX_CHARS.toLocaleString()}
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
          <p className="text-xs text-muted">
            Prefer CSS variables and{" "}
            <span className="font-mono text-gray-400">data-horde</span> /{" "}
            <span className="font-mono text-gray-400">data-page</span> hooks
            over one-off Tailwind class names — those can change between
            versions. Variables are space-separated RGB, e.g.{" "}
            <span className="font-mono text-gray-400">
              --accent: 255 120 40;
            </span>
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
                  className="text-accent underline underline-offset-2"
                >
                  Custom CSS wiki
                </a>
                .
              </p>
              <div>
                <p className="mb-1 font-medium uppercase tracking-wide text-muted">
                  Variables
                </p>
                <ul className="space-y-1">
                  {CSS_VARIABLES.map((row) => (
                    <li key={row.selector}>
                      <code className="text-gray-300">{row.selector}</code>
                      <span className="text-muted"> — </span>
                      {row.meaning}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="mb-1 font-medium uppercase tracking-wide text-muted">
                  Selectors
                </p>
                <ul className="space-y-1">
                  {CSS_SELECTORS.map((row) => (
                    <li key={row.selector}>
                      <code className="text-gray-300">{row.selector}</code>
                      <span className="text-muted"> — </span>
                      {row.meaning}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        </div>
      </Collapse>
    </Section>
  );
}
