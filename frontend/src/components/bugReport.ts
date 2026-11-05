export const REPO_URL = "https://github.com/jm-connell/horde";

/** The issue form, with the running version filled in when it is known. */
export function bugReportUrl(version: string | null | undefined): string {
  const qs = new URLSearchParams({ template: "bug_report.yml" });
  if (version && version !== "dev") qs.set("version", version);
  return `${REPO_URL}/issues/new?${qs}`;
}
