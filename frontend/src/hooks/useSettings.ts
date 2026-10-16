import { useCallback, useEffect, useRef, useState } from "react";
import { applyCustomCss } from "../customCss";
import { applyUiFont } from "../fonts";
import { applyMotionPrefs, applyTheme } from "./settings/applyToDom";
import {
  loadSettings,
  persistLocal,
  SETTINGS_CHANGED_EVENT,
} from "./settings/localStore";
import { normalizeSettings } from "./settings/migrations";
import {
  ensureServerHydration,
  isServerHydrated,
  scheduleServerSync,
  SETUP_EVENT,
  setupCompleted,
} from "./settings/serverSync";
import type { Settings } from "./settings/types";

export type * from "./settings/types";
export { applyMotionPrefs, applyTheme } from "./settings/applyToDom";
export { clearLocalSettings, loadSettings } from "./settings/localStore";
export { normalizeDownloadVideoCodec } from "./settings/migrations";
export {
  serverUiToSettingsPatch,
  settingsToServerUi,
} from "./settings/serverUi";
export {
  adoptSettingsOwner,
  flushSettingsSync,
  markSetupCompleted,
} from "./settings/serverSync";

export function useSetupGate(): { ready: boolean; completed: boolean } {
  const [ready, setReady] = useState(isServerHydrated);
  const [completed, setCompleted] = useState(setupCompleted);

  useEffect(() => {
    const sync = () => {
      setReady(true);
      setCompleted(setupCompleted());
    };
    void ensureServerHydration().then(sync);
    window.addEventListener(SETUP_EVENT, sync);
    return () => window.removeEventListener(SETUP_EVENT, sync);
  }, []);

  return { ready, completed };
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  useEffect(() => {
    const sync = () => setSettings(loadSettings());
    window.addEventListener(SETTINGS_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Shared hydrate — only one network call no matter how many subscribers.
  useEffect(() => {
    let cancelled = false;
    void ensureServerHydration().then(() => {
      if (!cancelled) setSettings(loadSettings());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    applyTheme(settings.theme, settings.customColors);
  }, [settings.theme, settings.customColors]);

  useEffect(() => {
    applyCustomCss(settings.customCss, settings.customCssEnabled);
  }, [settings.customCss, settings.customCssEnabled]);

  useEffect(() => {
    void applyUiFont({
      uiFont: settings.uiFont,
      customFonts: settings.customFonts,
    });
  }, [settings.uiFont, settings.customFonts]);

  const prevFontSize = useRef(settings.fontSize);

  useEffect(() => {
    const sizeChanged = prevFontSize.current !== settings.fontSize;
    const pinEl = sizeChanged
      ? document.querySelector<HTMLElement>("[data-font-size-control]")
      : null;
    const oldTop = pinEl?.getBoundingClientRect().top ?? null;
    prevFontSize.current = settings.fontSize;

    applyMotionPrefs(settings);

    if (oldTop != null) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const el = document.querySelector<HTMLElement>(
            "[data-font-size-control]"
          );
          if (!el) return;
          const newTop = el.getBoundingClientRect().top;
          window.scrollBy(0, newTop - oldTop);
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applyMotionPrefs only reads the motion/panel fields listed here; depending on the whole settings object would re-run it on unrelated changes
  }, [
    settings.navIndicator,
    settings.hoverMotion,
    settings.translucentPanelStrength,
    settings.translucentPanelBlur,
    settings.translucentPanelTintEnabled,
    settings.translucentPanelTint,
    settings.translucentPanelTintStrength,
    settings.translucentPanelLegibility,
    settings.fontSize,
  ]);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => applyMotionPrefs(loadSettings());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    const next = normalizeSettings({ ...loadSettings(), ...patch });
    persistLocal(next);
    scheduleServerSync(next);
  }, []);

  return [settings, update];
}
