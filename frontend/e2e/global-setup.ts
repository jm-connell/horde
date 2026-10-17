import { request, type FullConfig } from "@playwright/test";
import { ACCOUNTS, storageStatePath, type AccountName } from "./accounts";

/**
 * Sign each seeded account in once, through the real login endpoint, and save the
 * browser state. The app and mobile projects start from the admin's state; specs
 * that need another user open a context with that user's file. Resets between
 * tests keep these accounts and their sessions (see e2e_seed.py).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const appProject = config.projects.find((p) => p.name === "app");
  const baseURL = appProject?.use.baseURL;
  if (!baseURL) throw new Error("app project has no baseURL");

  for (const name of Object.keys(ACCOUNTS) as AccountName[]) {
    const ctx = await request.newContext({
      baseURL,
      extraHTTPHeaders: { "X-Horde-Request": "1" },
    });
    const resp = await ctx.post("/api/auth/login", { data: ACCOUNTS[name] });
    if (!resp.ok()) {
      throw new Error(
        `e2e login as ${name} failed: ${resp.status()} ${await resp.text()}`
      );
    }
    await ctx.storageState({ path: storageStatePath(name) });
    await ctx.dispose();
  }
}
