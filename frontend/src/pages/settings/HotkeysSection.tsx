import { useEffect, useState } from "react";
import {
  HOTKEYS,
  assignHotkey,
  isBindableKey,
  keyLabel,
  resetHotkey,
  resolveHotkeys,
  type HotkeyAction,
} from "../../hotkeys";
import { CHIP, CHIP_ACTIVE, PANEL_BTN } from "./constants";
import { Section, SettingRow, Toggle } from "./ui";
import { useSettingsPage } from "./context";

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

export default function HotkeysSection() {
  const { match, settings, update } = useSettingsPage();
  const [recording, setRecording] = useState<HotkeyAction | null>(null);
  const map = resolveHotkeys(settings.hotkeys);

  // While a binding is being changed, the next key press is the new key.
  // Capture phase, so the player and nav handlers never see it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Shift alone is the start of ">" or "?": wait for the real key.
      if (MODIFIER_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== "Escape" && isBindableKey(e.key)) {
        update({ hotkeys: assignHotkey(settings.hotkeys, recording, e.key) });
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, settings.hotkeys, update]);

  const customized = Object.keys(settings.hotkeys).length > 0;

  return (
    <Section
      anchor="hotkeys"
      title="Hotkeys"
      hidden={
        !match(
          "hotkeys",
          "shortcut",
          "keyboard",
          "keys",
          "single",
          ...HOTKEYS.map((h) => h.label.toLowerCase())
        )
      }
    >
      <div className="space-y-4">
        <SettingRow
          title="Single-character hotkeys"
          description="Letter, symbol and Space keys. Turn off if they clash with speech input or assistive software; arrow keys keep working."
          control={
            <Toggle
              checked={settings.playerShortcuts}
              onChange={() =>
                update({ playerShortcuts: !settings.playerShortcuts })
              }
            />
          }
        />
        {(["General", "Player"] as const).map((group) => (
          <div key={group}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
              {group}
            </h3>
            <ul className="divide-y divide-ink-800 rounded-lg border border-ink-700">
              {HOTKEYS.filter((h) => h.group === group).map((h) => {
                const keys = map[h.id];
                const isRecording = recording === h.id;
                const shown = isRecording
                  ? "Press a key…"
                  : keys.length
                    ? keys.map(keyLabel).join(" / ")
                    : "None";
                return (
                  <li
                    key={h.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <span className="text-sm text-gray-200">{h.label}</span>
                    <span className="flex items-center gap-2">
                      {settings.hotkeys[h.id] && (
                        <button
                          type="button"
                          className="text-xs text-muted hover:text-gray-200"
                          onClick={() =>
                            update({
                              hotkeys: resetHotkey(settings.hotkeys, h.id),
                            })
                          }
                          aria-label={`Reset ${h.label} to its default key`}
                        >
                          Reset
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={`${h.label}: ${shown}`}
                        aria-pressed={isRecording}
                        onClick={() => setRecording(isRecording ? null : h.id)}
                        className={`${isRecording ? CHIP_ACTIVE : CHIP} min-w-24 justify-center font-mono text-xs!`}
                      >
                        {shown}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {customized && (
          <button
            type="button"
            className={PANEL_BTN}
            onClick={() => update({ hotkeys: {} })}
          >
            Reset all hotkeys
          </button>
        )}
      </div>
    </Section>
  );
}
