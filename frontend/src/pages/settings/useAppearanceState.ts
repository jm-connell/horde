import { useEffect, useState } from "react";
import { api } from "../../api";
import { describeError } from "../../apiErrors";
import { useConfirm } from "../../context/ConfirmContext";
import { newCustomFontId, parseCustomFontInput } from "../../fonts";
import { loadSettings } from "../../hooks/useSettings";
import type { CustomThemePreset } from "../../hooks/useSettings";
import type { BackgroundItem } from "../../types";
import { useSettingsPage } from "./context";

/** State and actions of the Appearance tab: saved themes, fonts and backgrounds. */
export function useAppearanceState() {
  const { settings, update, showToast, showError } = useSettingsPage();
  const confirm = useConfirm();
  const [navPreview, setNavPreview] = useState<"home" | "library" | "settings">(
    "home"
  );
  const [bgUploading, setBgUploading] = useState(false);
  const [paletteColors, setPaletteColors] = useState<string[]>([]);
  const [paletteLoading, setPaletteLoading] = useState(false);
  const [customFontDraft, setCustomFontDraft] = useState("");
  const [themeNameDraft, setThemeNameDraft] = useState("");
  const [bgLibrary, setBgLibrary] = useState<BackgroundItem[]>([]);
  const [lastUploadedName, setLastUploadedName] = useState<string | null>(null);

  useEffect(() => {
    setPaletteColors([]);
  }, [settings.customBackgroundId]);

  const refreshBgLibrary = () =>
    api
      .listBackgrounds()
      .then((r) => setBgLibrary(r.items ?? []))
      .catch(() => setBgLibrary([]));

  useEffect(() => {
    if (settings.backgroundEffect !== "none") {
      refreshBgLibrary();
    }
  }, [settings.backgroundEffect]);

  const uploadCustomBackground = async (file: File | null) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast("Large file (>10MB) — upload may be slow");
    }
    setBgUploading(true);
    let result: Awaited<ReturnType<typeof api.uploadBackground>>;
    try {
      result = await api.uploadBackground(file);
    } catch (err) {
      showError(`Background upload failed: ${describeError(err)}`);
      return;
    } finally {
      setBgUploading(false);
    }
    const name = result.filename || file.name;
    setLastUploadedName(name);
    update({
      backgroundEffect: "custom-image",
      customBackgroundId: result.id,
      customBackgroundMime: result.mime,
    });
    setPaletteColors([]);
    await refreshBgLibrary();
    showToast("Background uploaded");
  };

  const deleteLibraryBackground = async (id: string) => {
    const ok = await confirm({
      title: "Delete this background?",
      body: "The image is removed from your library and can't be restored.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    const result = await api.deleteBackground(id).catch((err) => {
      showError(`Could not delete background: ${describeError(err)}`);
      return null;
    });
    if (!result?.ok) {
      if (result) showError("Could not delete background");
      return;
    }
    if (settings.customBackgroundId === id) {
      const remaining = bgLibrary.filter((b) => b.id !== id);
      const next = remaining[0];
      if (next) {
        update({
          customBackgroundId: next.id,
          customBackgroundMime: next.mime,
        });
      } else {
        update({
          customBackgroundId: null,
          customBackgroundMime: null,
        });
      }
    }
    await refreshBgLibrary();
  };

  const saveCurrentAsTheme = () => {
    const name = themeNameDraft.trim();
    if (!name) {
      showToast("Enter a theme name");
      return;
    }
    const current = loadSettings();
    const preset: CustomThemePreset = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : String(Date.now()),
      name: name.slice(0, 64),
      customColors: { ...current.customColors },
      backgroundEffect: current.backgroundEffect,
      backgroundOpacity: current.backgroundOpacity,
      backgroundEffectSpeed: current.backgroundEffectSpeed,
      backgroundEffectSize: current.backgroundEffectSize,
      backgroundEffectColorMode: current.backgroundEffectColorMode,
      backgroundEffectColor: current.backgroundEffectColor,
      flowingGradientPreset: current.flowingGradientPreset,
      customBackgroundId: current.customBackgroundId,
      customBackgroundMime: current.customBackgroundMime,
      customBackgroundBlur: current.customBackgroundBlur,
      customBackgroundTint: current.customBackgroundTint,
      customBackgroundTintOpacity: current.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: current.pauseBackgroundWhileWatching,
      navIndicator: current.navIndicator,
      hoverMotion: current.hoverMotion,
      translucentPanelStrength: current.translucentPanelStrength,
      translucentPanelBlur: current.translucentPanelBlur,
      translucentPanelTintEnabled: current.translucentPanelTintEnabled,
      translucentPanelTint: current.translucentPanelTint,
      translucentPanelTintStrength: current.translucentPanelTintStrength,
      translucentPanelLegibility: current.translucentPanelLegibility,
      loadingStyle: current.loadingStyle,
      fontSize: current.fontSize,
      uiFont: current.uiFont === "custom" ? "default" : current.uiFont,
      customCss: current.customCss,
      customCssEnabled: current.customCssEnabled,
    };
    update({ customThemes: [...current.customThemes, preset] });
    setThemeNameDraft("");
    showToast(`Saved theme “${preset.name}”`);
  };

  const addCustomFontFromUrl = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const parsed = parseCustomFontInput(trimmed);
    if (!parsed.family || !parsed.cssUrl) {
      showToast("Could not parse that font");
      return;
    }
    const current = loadSettings();
    const existing = current.customFonts.find(
      (f) =>
        f.source === "url" &&
        (f.url === trimmed ||
          f.name.toLowerCase() === parsed.family!.toLowerCase())
    );
    if (existing) {
      update({ uiFont: existing.id });
      setCustomFontDraft("");
      showToast(`“${existing.name}” is already saved`);
      return;
    }
    const id = newCustomFontId();
    update({
      customFonts: [
        ...current.customFonts,
        { id, name: parsed.family, source: "url", url: trimmed },
      ],
      uiFont: id,
    });
    setCustomFontDraft("");
    showToast(`Saved “${parsed.family}”`);
  };

  const applyCustomTheme = (preset: CustomThemePreset) => {
    update({
      theme: "custom",
      customColors: { ...preset.customColors },
      backgroundEffect: preset.backgroundEffect,
      backgroundOpacity: preset.backgroundOpacity,
      backgroundEffectSpeed: preset.backgroundEffectSpeed,
      backgroundEffectSize: preset.backgroundEffectSize,
      backgroundEffectColorMode: preset.backgroundEffectColorMode,
      backgroundEffectColor: preset.backgroundEffectColor,
      flowingGradientPreset: preset.flowingGradientPreset,
      customBackgroundId: preset.customBackgroundId,
      customBackgroundMime: preset.customBackgroundMime,
      customBackgroundBlur: preset.customBackgroundBlur,
      customBackgroundTint: preset.customBackgroundTint,
      customBackgroundTintOpacity: preset.customBackgroundTintOpacity,
      pauseBackgroundWhileWatching: preset.pauseBackgroundWhileWatching,
      navIndicator: preset.navIndicator,
      hoverMotion: preset.hoverMotion,
      translucentPanelStrength: preset.translucentPanelStrength,
      translucentPanelBlur: preset.translucentPanelBlur,
      translucentPanelTintEnabled: preset.translucentPanelTintEnabled,
      translucentPanelTint: preset.translucentPanelTint,
      translucentPanelTintStrength: preset.translucentPanelTintStrength,
      translucentPanelLegibility: preset.translucentPanelLegibility,
      loadingStyle: preset.loadingStyle,
      fontSize: preset.fontSize,
      uiFont: preset.uiFont,
      customCss: preset.customCss,
      customCssEnabled: preset.customCssEnabled,
    });
    showToast(`Applied “${preset.name}”`);
  };

  const deleteCustomTheme = (id: string) => {
    update({
      customThemes: settings.customThemes.filter((t) => t.id !== id),
    });
  };

  const extractPalette = async () => {
    if (!settings.customBackgroundId || paletteLoading) return;
    setPaletteLoading(true);
    const result = await api
      .extractBackgroundPalette(settings.customBackgroundId)
      .catch((err) => {
        showError(`Could not extract palette: ${describeError(err)}`);
        return null;
      });
    setPaletteLoading(false);
    if (result && !result.colors?.length) {
      showError("Could not extract palette");
    }
    if (!result?.colors?.length) return;
    setPaletteColors(result.colors);
  };

  const applyPaletteColor = (color: string) => {
    const hex = color.replace("#", "");
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const dark = `#${Math.round(r * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(g * 0.12)
      .toString(16)
      .padStart(2, "0")}${Math.round(b * 0.12)
      .toString(16)
      .padStart(2, "0")}`;
    update({
      theme: "custom",
      customColors: {
        accent: color.toLowerCase(),
        background: dark,
      },
      customBackgroundTint: dark,
    });
  };

  return {
    themeNameDraft,
    setThemeNameDraft,
    saveCurrentAsTheme,
    applyCustomTheme,
    deleteCustomTheme,
    customFontDraft,
    setCustomFontDraft,
    addCustomFontFromUrl,
    bgUploading,
    uploadCustomBackground,
    lastUploadedName,
    bgLibrary,
    deleteLibraryBackground,
    paletteColors,
    paletteLoading,
    extractPalette,
    applyPaletteColor,
    navPreview,
    setNavPreview,
  };
}

export type AppearanceState = ReturnType<typeof useAppearanceState>;
