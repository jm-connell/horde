// Generate src/api/schema.d.ts from the backend's committed OpenAPI document.
//
//   node scripts/gen-api.mjs           regenerate the file
//   node scripts/gen-api.mjs --check   exit 1 when the file is stale
//
// The document itself is written by `python -m app.export_openapi openapi.json`
// (see backend/app/export_openapi.py); run that first when the API changed.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = join(root, "..", "backend", "openapi.json");
const target = join(root, "src", "api", "schema.d.ts");
const check = process.argv.includes("--check");
const bin = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "openapi-typescript.cmd" : "openapi-typescript"
);

const scratch = mkdtempSync(join(tmpdir(), "horde-gen-api-"));
try {
  const out = check ? join(scratch, "schema.d.ts") : target;
  execFileSync(bin, [input, "-o", out], {
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
  });
  if (check) {
    const fresh = readFileSync(out, "utf8");
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // missing file counts as stale
    }
    if (fresh !== current) {
      console.error(
        "src/api/schema.d.ts is out of date; run `npm run gen:api` and commit it."
      );
      process.exitCode = 1;
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
