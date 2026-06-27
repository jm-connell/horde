import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = join(here, "..");
const dist = join(frontendRoot, "dist");
const target = join(frontendRoot, "..", "backend", "static");

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
console.log(`Synced ${dist} -> ${target}`);
