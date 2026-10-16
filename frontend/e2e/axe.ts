import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/**
 * axe-core on every main page. Serious and critical violations fail the test;
 * minor/moderate ones are reported in the failure output only when something
 * else fails. Do not add exclusions without a comment saying why.
 */
export async function expectNoSeriousViolations(
  page: Page,
  label: string,
  scope?: string
) {
  // The page fades in on navigation; contrast measured mid-fade is meaningless.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => null))
    )
  );
  let axe = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);
  if (scope) axe = axe.include(scope);
  const results = await axe.analyze();
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );
  const summary = serious.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes
        .slice(0, 5)
        .map(
          (n) =>
            `    ${n.target.join(" ")}  ${n.html.slice(0, 160)}\n      ${n.failureSummary ?? ""}`
        )
        .join("\n")
  );
  expect(summary, `${label}\n${summary.join("\n")}`).toEqual([]);
}
