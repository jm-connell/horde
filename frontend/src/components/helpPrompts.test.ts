import { describe, expect, it } from "vitest";
import {
  capabilitiesAnswer,
  pickPrompts,
  promptAllowed,
  SAMPLE_PROMPTS,
  WHAT_CAN_YOU_DO,
} from "./helpPrompts";

const member = { isAdmin: false, can: () => false };

describe("pickPrompts", () => {
  it("leads with What can you do? and adds four from different areas", () => {
    for (let seed = 0; seed < 20; seed++) {
      let n = seed;
      const random = () => (n = (n * 9301 + 49297) % 233280) / 233280;
      const picked = pickPrompts(() => true, random);
      expect(picked).toHaveLength(5);
      expect(picked[0]).toBe(WHAT_CAN_YOU_DO);
      const areas = picked
        .slice(1)
        .map((t) => SAMPLE_PROMPTS.find((p) => p.text === t)?.area);
      expect(new Set(areas).size).toBe(4);
    }
  });

  it("varies between openings", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(pickPrompts(() => true).join("|"));
    expect(seen.size).toBeGreaterThan(5);
  });

  it("keeps administrator and permission prompts from others", () => {
    const allowed = SAMPLE_PROMPTS.filter((p) => promptAllowed(p, member));
    expect(allowed.some((p) => p.admin || p.needs)).toBe(false);
    expect(allowed.length).toBeGreaterThan(10);
  });
});

describe("capabilitiesAnswer", () => {
  it("names the model for administrators and warns about small ones", () => {
    const text = capabilitiesAnswer({
      info: {
        model: "llama3.2:3b",
        tier: "small",
        provider_label: "x",
        local: true,
        available: true,
      },
      isAdmin: true,
      canDownload: true,
    });
    expect(text).toContain("`llama3.2:3b`, a small model");
    expect(text).toContain("[[setting:ai-models]]");
    expect(text).toContain("Download links");
  });

  it("keeps the model and admin links from members", () => {
    const text = capabilitiesAnswer({
      info: {
        model: null,
        tier: "small",
        provider_label: "x",
        local: false,
        available: true,
      },
      isAdmin: false,
      canDownload: false,
    });
    expect(text).not.toContain("[[setting:ai-models]]");
    expect(text).not.toContain("Download links");
    expect(text).toContain("The administrator can give me a stronger model");
  });
});
