import { describe, expect, it } from "vitest";
import { BACKGROUND_EFFECT_OPTIONS } from "../../effects";
import { LOADING_STYLE_OPTIONS } from "../../loadingStyles";
import {
  HOVER_MOTION_OPTIONS,
  NAV_INDICATOR_OPTIONS,
} from "../../pages/settings/constants";
import { EFFECT_CONTROLS } from "../../effects/controls";
import { DEFAULTS } from "./defaults";
import { migratePanelTranslucency, normalizeSettings } from "./migrations";
import { serverUiToSettingsPatch, settingsToServerUi } from "./serverUi";

describe("normalizeSettings", () => {
  it("fills every missing field from the defaults", () => {
    expect(normalizeSettings({})).toEqual(DEFAULTS);
  });

  it("maps a retired theme name onto its replacement", () => {
    const next = normalizeSettings({ theme: "macos" as never });
    expect(next.theme).toBe("slate");
  });

  it("falls back to the default theme for an unknown one", () => {
    expect(normalizeSettings({ theme: "nope" as never }).theme).toBe("default");
  });

  it("turns an old UI scale percentage into a font size", () => {
    expect(normalizeSettings({ uiScale: 85 }).fontSize).toBe("small");
    expect(normalizeSettings({ uiScale: 100 }).fontSize).toBe("medium");
    expect(normalizeSettings({ uiScale: 130 }).fontSize).toBe("large");
    // A saved font size wins over the legacy scale.
    expect(normalizeSettings({ fontSize: "xl", uiScale: 85 }).fontSize).toBe(
      "xl"
    );
  });

  it("drops the legacy keys it migrates from", () => {
    const next = normalizeSettings({
      liquidNav: true,
      translucentPanels: true,
      uiScale: 100,
      aiTab: "x",
    });
    for (const key of ["liquidNav", "translucentPanels", "uiScale", "aiTab"]) {
      expect(next).not.toHaveProperty(key);
    }
  });

  // A choice the pickers offer but validation forgot resets on the next load.
  it("keeps every option Settings offers", () => {
    for (const o of BACKGROUND_EFFECT_OPTIONS) {
      expect(
        normalizeSettings({ backgroundEffect: o.value }).backgroundEffect
      ).toBe(o.value);
    }
    for (const o of LOADING_STYLE_OPTIONS) {
      expect(normalizeSettings({ loadingStyle: o.value }).loadingStyle).toBe(
        o.value
      );
    }
    for (const o of NAV_INDICATOR_OPTIONS) {
      expect(normalizeSettings({ navIndicator: o.value }).navIndicator).toBe(
        o.value
      );
    }
    for (const o of HOVER_MOTION_OPTIONS) {
      expect(normalizeSettings({ hoverMotion: o.value }).hoverMotion).toBe(
        o.value
      );
    }
  });

  // Options that were removed: nobody is left on a blank choice.
  it.each([
    ["snow", "snowfall"],
    ["galaxy", "spiral-galaxy"],
    ["flowing-gradient", "mesh-gradient"],
    ["aurora", "mesh-gradient"],
    ["plexus", "constellation"],
    ["fireflies", "none"],
    ["film", "none"],
  ])("moves the removed background %s to %s", (from, to) => {
    expect(
      normalizeSettings({ backgroundEffect: from as never }).backgroundEffect
    ).toBe(to);
  });

  it.each([
    ["arc", "spinner"],
    ["spinner", "spinner"],
    ["bar", "sweep"],
    ["comet", "dots"],
    ["clapper", "dots"],
  ])("moves the removed loader %s to %s", (from, to) => {
    expect(
      normalizeSettings({ loadingStyle: from as never }).loadingStyle
    ).toBe(to);
  });

  it("moves the removed nav indicator and hover motions to kept ones", () => {
    expect(
      normalizeSettings({ navIndicator: "stretch" as never }).navIndicator
    ).toBe("underline");
    for (const hover of ["tilt", "zoom"]) {
      expect(
        normalizeSettings({ hoverMotion: hover as never }).hoverMotion
      ).toBe("subtle");
    }
  });

  it("maps removed options inside a saved custom theme too", () => {
    const [preset] = normalizeSettings({
      customThemes: [
        {
          id: "a",
          name: "Old",
          backgroundEffect: "snow",
          loadingStyle: "bar",
          navIndicator: "stretch",
          hoverMotion: "tilt",
        } as never,
      ],
    }).customThemes;
    expect(preset.backgroundEffect).toBe("snowfall");
    expect(preset.loadingStyle).toBe("sweep");
    expect(preset.navIndicator).toBe("underline");
    expect(preset.hoverMotion).toBe("subtle");
    expect(preset.backgroundEffectOptions).toEqual({});
  });

  it("keeps a background's slider values and drops junk", () => {
    const slider = EFFECT_CONTROLS.rain.sliders[0];
    const next = normalizeSettings({
      backgroundEffectOptions: {
        rain: { [slider.key]: slider.max + 1000, nope: 3 },
        snow: { wind: 1 },
        dust: "x",
      } as never,
    }).backgroundEffectOptions;
    expect(next.rain[slider.key]).toBe(slider.max);
    expect(next.rain).not.toHaveProperty("nope");
    expect(next).not.toHaveProperty("snow");
    expect(Object.values(next.dust).every(Number.isFinite)).toBe(true);
    expect(
      normalizeSettings({ backgroundEffectOptions: 4 as never })
        .backgroundEffectOptions
    ).toEqual({});
  });

  it("clamps the panel sliders into 0..1", () => {
    const next = normalizeSettings({
      translucentPanelStrength: 4,
      translucentPanelBlur: -2,
    });
    expect(next.translucentPanelStrength).toBe(1);
    expect(next.translucentPanelBlur).toBe(0);
  });
});

describe("migratePanelTranslucency", () => {
  it("keeps independent sliders when a blur value is saved", () => {
    expect(
      migratePanelTranslucency({
        translucentPanelStrength: 0.4,
        translucentPanelBlur: 0.25,
      })
    ).toEqual({ translucentPanelStrength: 0.4, translucentPanelBlur: 0.25 });
  });

  it("treats the old off toggle as fully opaque", () => {
    expect(migratePanelTranslucency({ translucentPanels: false })).toEqual({
      translucentPanelStrength: 0,
      translucentPanelBlur: 0,
    });
  });

  it("un-couples the old blur from the strength when the toggle was on", () => {
    const out = migratePanelTranslucency({
      translucentPanels: true,
      translucentPanelStrength: 0.65,
    });
    expect(out.translucentPanelStrength).toBe(0.65);
    // (1 - 0.65) * 14px of blur, as a share of the 24px maximum.
    expect(out.translucentPanelBlur).toBeCloseTo((0.35 * 14) / 24);
  });

  it("uses the defaults when nothing was saved", () => {
    expect(migratePanelTranslucency({})).toEqual({
      translucentPanelStrength: DEFAULTS.translucentPanelStrength,
      translucentPanelBlur: DEFAULTS.translucentPanelBlur,
    });
  });
});

describe("server ui mapping", () => {
  it("sends snake_case keys and leaves out session-only fields", () => {
    const ui = settingsToServerUi({ ...DEFAULTS, theme: "nord" });
    expect(ui.theme).toBe("nord");
    expect(ui).toHaveProperty("default_library_sort");
    expect(ui).not.toHaveProperty("progress_expiry_days");
    expect(Object.keys(ui).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it("reads snake_case back into the same settings", () => {
    const original = {
      ...DEFAULTS,
      theme: "nord" as const,
      fontSize: "xl" as const,
    };
    const patch = serverUiToSettingsPatch(settingsToServerUi(original));
    expect(normalizeSettings({ ...DEFAULTS, ...patch })).toEqual(original);
  });

  it("ignores keys the app does not know", () => {
    expect(serverUiToSettingsPatch({ not_a_setting: 1 })).toEqual({});
  });

  it("migrates an old blob that stored a toggle instead of a blur slider", () => {
    const patch = serverUiToSettingsPatch({
      translucent_panels: false,
    });
    expect(patch.translucentPanelStrength).toBe(0);
    expect(patch.translucentPanelBlur).toBe(0);
  });
});
