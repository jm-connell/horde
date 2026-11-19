import { afterEach, describe, expect, it, vi } from "vitest";
import {
  avoidMiniPlayerStyle,
  clampMiniPos,
  miniFrameFromNorthWestResize,
  miniPlayerHostInsets,
} from "./miniPlayerLayout";

describe("miniFrameFromNorthWestResize", () => {
  it("keeps the bottom-right corner fixed when growing", () => {
    const start = { left: 120, top: 80, width: 400, height: 225 };
    const next = miniFrameFromNorthWestResize(start, 500);
    expect(next.width).toBe(500);
    expect(next.height).toBe(281.25);
    expect(next.left + next.width).toBe(start.left + start.width);
    expect(next.top + next.height).toBe(start.top + start.height);
    expect(next.left).toBe(20);
    expect(next.top).toBe(23.75);
  });

  it("keeps the bottom-right corner fixed when shrinking", () => {
    const start = { left: 200, top: 150, width: 640, height: 360 };
    const next = miniFrameFromNorthWestResize(start, 320);
    expect(next.left + next.width).toBe(start.left + start.width);
    expect(next.top + next.height).toBe(start.top + start.height);
    expect(next.left).toBe(520);
    expect(next.top).toBe(330);
  });
});

describe("miniPlayerHostInsets", () => {
  it("anchors the undragged mini player with right/bottom so it tracks resize", () => {
    const insets = miniPlayerHostInsets(
      null,
      { width: 400, height: 225 },
      false
    );
    expect(insets.right).toBe("calc(16px + var(--horde-chat-dock, 0px))");
    expect(insets.bottom).toBe("calc(16px + var(--horde-bottom-bar, 0px))");
    expect(insets.left).toBe("auto");
    expect(insets.top).toBe("auto");
  });

  it("uses a tighter corner margin on mobile", () => {
    const insets = miniPlayerHostInsets(
      null,
      { width: 224, height: 126 },
      true
    );
    expect(insets.right).toBe("calc(12px + var(--horde-chat-dock, 0px))");
    expect(insets.bottom).toBe("calc(12px + var(--horde-bottom-bar, 0px))");
  });

  it("clamps a dragged mini player onto a smaller viewport", () => {
    const insets = miniPlayerHostInsets(
      { left: 2000, top: 1500 },
      { width: 400, height: 225 },
      false,
      800,
      600
    );
    expect(insets.left).toBe("392px");
    expect(insets.top).toBe("367px");
    expect(insets.right).toBe("auto");
    expect(insets.bottom).toBe("auto");
  });
});

describe("clampMiniPos", () => {
  it("keeps an on-screen position unchanged", () => {
    expect(clampMiniPos(40, 50, 400, 225, 1200, 800)).toEqual({
      left: 40,
      top: 50,
    });
  });

  describe("in the window", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("keeps a dragged mini player above the installed app's tab bar", () => {
      vi.stubGlobal("window", { innerWidth: 400, innerHeight: 800 });
      vi.stubGlobal("document", { documentElement: {} });
      vi.stubGlobal("getComputedStyle", () => ({
        getPropertyValue: () => "64px",
      }));
      expect(clampMiniPos(10, 900, 200, 100)).toEqual({
        left: 10,
        top: 800 - 64 - 100 - 8,
      });
    });
  });
});

describe("avoidMiniPlayerStyle", () => {
  const corner = "calc(16px + var(--horde-bottom-bar, 0px))";
  const mini = {
    left: 784,
    top: 359,
    width: 400,
    height: 225,
    right: 1184,
    bottom: 584,
  };

  it("sits bottom-left, away from Ask, toasts and a bottom-right mini", () => {
    for (const rect of [null, mini]) {
      const style = avoidMiniPlayerStyle(rect, {
        viewportWidth: 1200,
        viewportHeight: 800,
      });
      expect(style.left).toBe(16);
      expect(style.right).toBeUndefined();
      expect(style.bottom).toBe(corner);
      expect(style.width).toBe("22rem");
    }
  });

  it("stays bottom-left when corner-anchored even if the mini rect is stale", () => {
    // After a resize the rect can read as left of centre; the mini is not.
    const style = avoidMiniPlayerStyle(mini, {
      viewportWidth: 2000,
      viewportHeight: 800,
      cornerAnchor: true,
    });
    expect(style.left).toBe(16);
    expect(style.bottom).toBe(corner);
  });

  it("parks above a mini player dragged to the left", () => {
    const left = { ...mini, left: 40, right: 440 };
    const style = avoidMiniPlayerStyle(left, {
      viewportWidth: 1200,
      viewportHeight: 800,
    });
    expect(style.left).toBe(40);
    expect(style.bottom).toBe(800 - 359 + 16);
  });

  it("lifts above a bottom-docked queue", () => {
    const style = avoidMiniPlayerStyle(null, { queueBottomLiftPx: 200 });
    expect(style.bottom).toBe("calc(200px + var(--horde-bottom-bar, 0px))");
  });

  it("honors a custom panel width", () => {
    const style = avoidMiniPlayerStyle(null, { panelWidthRem: 14 });
    expect(style.width).toBe("14rem");
  });
});
