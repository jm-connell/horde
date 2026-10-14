import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import type { Plugin } from "vite";

/**
 * Bundles src/offline/sw.ts into dist/sw.js at build time, injecting the list
 * of shell files to precache and a version derived from their hashed names.
 * Not active in `vite dev` (the app only registers the worker in production).
 */
export function hordeServiceWorker(): Plugin {
  let root = process.cwd();
  let publicDir = "";
  return {
    name: "horde-service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir;
    },
    async generateBundle(_options, bundle) {
      const files = new Set<string>(["/index.html"]);
      for (const fileName of Object.keys(bundle)) {
        // Shell = everything Vite emitted (hashed JS/CSS/fonts/images).
        if (fileName.endsWith(".map")) continue;
        files.add(`/${fileName}`);
      }
      if (publicDir) {
        for (const name of readdirSync(publicDir)) files.add(`/${name}`);
      }
      files.delete("/sw.js");
      const precache = [...files].sort();
      const version = createHash("sha256")
        .update(precache.join("\n"))
        .digest("hex")
        .slice(0, 12);

      const result = await build({
        entryPoints: [path.join(root, "src/offline/sw.ts")],
        bundle: true,
        write: false,
        format: "iife",
        target: "es2020",
        minify: true,
        define: {
          __PRECACHE__: JSON.stringify(precache),
          __SW_VERSION__: JSON.stringify(version),
        },
      });
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: result.outputFiles[0].text,
      });
    },
  };
}
