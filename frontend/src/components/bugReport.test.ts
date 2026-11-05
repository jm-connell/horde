import { describe, expect, it } from "vitest";
import { bugReportUrl } from "./bugReport";

describe("bugReportUrl", () => {
  it("fills in the running version", () => {
    expect(bugReportUrl("1.2.2")).toBe(
      "https://github.com/jm-connell/horde/issues/new?template=bug_report.yml&version=1.2.2"
    );
  });

  it("leaves it out when unknown or a development build", () => {
    for (const v of [null, undefined, "dev"]) {
      expect(bugReportUrl(v)).toBe(
        "https://github.com/jm-connell/horde/issues/new?template=bug_report.yml"
      );
    }
  });
});
