import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ports and on-disk state of this run's e2e servers. Everything a run writes
 * (e2e/serve.py's data, the saved sign-ins) is keyed by the app port, so
 * several runs (`scripts/e2e-shards.sh`) can share one checkout.
 */
export const appPort = Number(process.env.E2E_APP_PORT || 8091);
export const setupPort = Number(process.env.E2E_SETUP_PORT || 8092);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

/** The app server's downloads folder (must match e2e/serve.py). */
export const appDownloads = path.join(
  repoRoot,
  "e2e",
  ".runtime",
  `app-${appPort}`,
  "downloads"
);
