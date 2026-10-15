import { describe, expect, it } from "vitest";
import {
  SAFARI_PREP_MAX_RETRIES,
  nextSafariPrepStep,
} from "./useLibraryRendition";

describe("nextSafariPrepStep", () => {
  it("finishes on ready and keeps waiting while a job is pending", () => {
    expect(nextSafariPrepStep("ready", 0)).toBe("ready");
    expect(nextSafariPrepStep("queued", 0)).toBe("wait");
    expect(nextSafariPrepStep("running", 2)).toBe("wait");
  });

  it("re-requests when the job vanished, a capped number of times", () => {
    for (let used = 0; used < SAFARI_PREP_MAX_RETRIES; used += 1) {
      expect(nextSafariPrepStep("none", used)).toBe("retry");
    }
    expect(nextSafariPrepStep("none", SAFARI_PREP_MAX_RETRIES)).toBe("fail");
  });

  it("gives up on errors so the player falls through", () => {
    expect(nextSafariPrepStep("error", 0)).toBe("fail");
  });
});
