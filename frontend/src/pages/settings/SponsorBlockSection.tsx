import { useEffect, useState } from "react";
import Collapse from "../../components/Collapse";
import HelpTip from "../../components/HelpTip";
import {
  SPONSOR_BLOCK_COMMON_CATEGORIES,
  SPONSOR_BLOCK_EXTRA_CATEGORIES,
  SPONSOR_BLOCK_EXTRA_SEARCH_KEYWORDS,
  SPONSOR_BLOCK_SEARCH_KEYWORDS,
  type SponsorBlockCategory,
} from "../../sponsorBlock";
import { Chip, Section, SettingRow, Toggle } from "./ui";
import { useSettingsPage } from "./context";

export default function SponsorBlockSection() {
  const { q, match, settings, update } = useSettingsPage();
  const extraSearchHit = Boolean(
    q && match(SPONSOR_BLOCK_EXTRA_SEARCH_KEYWORDS)
  );
  const [extrasOpen, setExtrasOpen] = useState(extraSearchHit);

  useEffect(() => {
    if (extraSearchHit) setExtrasOpen(true);
  }, [extraSearchHit]);

  const extraOnCount = SPONSOR_BLOCK_EXTRA_CATEGORIES.filter(
    (c) => settings.sponsorBlockCategories[c.id]
  ).length;

  const toggleCategory = (id: SponsorBlockCategory) => {
    update({
      sponsorBlockCategories: {
        ...settings.sponsorBlockCategories,
        [id]: !settings.sponsorBlockCategories[id],
      },
    });
  };

  return (
    <Section
      title="SponsorBlock"
      description="Skip sponsored segments and other non-content during YouTube playback. Has no effect on other sources. Files on disk are unchanged."
      hidden={!!q && !match(SPONSOR_BLOCK_SEARCH_KEYWORDS)}
    >
      <div className="space-y-4">
        <SettingRow
          title="Enable SponsorBlock"
          description="YouTube only — non-YouTube videos ignore this setting."
          control={
            <Toggle
              checked={settings.sponsorBlockEnabled}
              onChange={() =>
                update({
                  sponsorBlockEnabled: !settings.sponsorBlockEnabled,
                })
              }
            />
          }
        />
        {settings.sponsorBlockEnabled && (
          <>
            <SettingRow
              title="Skip behavior"
              description="Auto skip jumps over segments. Ask to skip shows a notice you can click."
              control={
                <div className="flex flex-wrap justify-end gap-2">
                  <Chip
                    active={settings.sponsorBlockSkipMode === "auto"}
                    onClick={() => update({ sponsorBlockSkipMode: "auto" })}
                  >
                    Auto skip
                  </Chip>
                  <Chip
                    active={settings.sponsorBlockSkipMode === "prompt"}
                    onClick={() => update({ sponsorBlockSkipMode: "prompt" })}
                  >
                    Ask to skip
                  </Chip>
                </div>
              }
            />
            {settings.sponsorBlockSkipMode === "auto" && (
              <SettingRow
                title="Show skip notice"
                description="Brief on-screen notification when a segment is skipped, with an undo control."
                control={
                  <Toggle
                    checked={settings.sponsorBlockShowNotice}
                    onChange={() =>
                      update({
                        sponsorBlockShowNotice:
                          !settings.sponsorBlockShowNotice,
                      })
                    }
                  />
                }
              />
            )}
            <div className="space-y-4">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                Categories
              </p>
              {SPONSOR_BLOCK_COMMON_CATEGORIES.map((cat) => (
                <SettingRow
                  key={cat.id}
                  title={cat.label}
                  description={cat.description}
                  control={
                    <Toggle
                      checked={settings.sponsorBlockCategories[cat.id]}
                      onChange={() => toggleCategory(cat.id)}
                    />
                  }
                />
              ))}
            </div>
            <div>
              <button
                type="button"
                onClick={() => setExtrasOpen((o) => !o)}
                aria-expanded={extrasOpen}
                className="mb-2 inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-gray-500 hover:text-gray-300"
              >
                <svg
                  viewBox="0 0 24 24"
                  className={`h-3 w-3 shrink-0 transition-transform duration-200 ease-out ${
                    extrasOpen ? "" : "-rotate-90"
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
                {extrasOpen
                  ? "Fewer categories"
                  : extraOnCount > 0
                    ? `More categories (${extraOnCount} on)`
                    : "More categories"}
              </button>
              <Collapse open={extrasOpen}>
                <div className="space-y-4 pt-1">
                  {SPONSOR_BLOCK_EXTRA_CATEGORIES.map((cat) => (
                    <SettingRow
                      key={cat.id}
                      title={cat.label}
                      control={
                        <div className="flex items-center gap-2">
                          <HelpTip text={cat.description} />
                          <Toggle
                            checked={settings.sponsorBlockCategories[cat.id]}
                            onChange={() => toggleCategory(cat.id)}
                          />
                        </div>
                      }
                    />
                  ))}
                </div>
              </Collapse>
            </div>
          </>
        )}
      </div>
    </Section>
  );
}
