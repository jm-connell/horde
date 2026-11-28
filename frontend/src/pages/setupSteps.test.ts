import { describe, expect, it } from "vitest";
import { STEPS, wizardSteps } from "./setupSteps";

describe("wizardSteps", () => {
  it("asks a server about playback compatibility", () => {
    expect(wizardSteps("server", true)).toEqual(STEPS);
    expect(wizardSteps(undefined, true)).toEqual(STEPS);
  });

  it("leaves the playback step out of a desktop app that plays AV1", () => {
    const steps = wizardSteps("desktop", true);
    expect(steps).not.toContain("playback");
    expect(steps).toHaveLength(STEPS.length - 1);
  });

  it("still asks a desktop app that cannot play AV1", () => {
    expect(wizardSteps("desktop", false)).toEqual(STEPS);
  });
});
