/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { hordeServiceWorker } from "./vite-plugin-sw";

export default defineConfig({
  plugins: [react(), tailwindcss(), hordeServiceWorker()],
  test: {
    environment: "node",
    // Playwright specs live next to the app but are not Vitest tests.
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
  build: {
    rollupOptions: {
      output: {
        // React + router change far less often than app code, so a separate
        // chunk stays cached across releases. Shaka is already a dynamic
        // import and keeps its own chunk.
        manualChunks(id) {
          if (
            /node_modules\/(react|react-dom|react-router|react-router-dom|scheduler|@remix-run\/router)\//.test(
              id
            )
          ) {
            return "vendor-react";
          }
          if (/node_modules\/@tanstack\//.test(id)) return "vendor-query";
        },
      },
    },
  },
  optimizeDeps: {
    include: [
      "shaka-player/dist/shaka-player.dash.js",
      "shaka-player/dist/shaka-player.hls.js",
    ],
  },
  server: {
    // Keep the browser's Host header (changeOrigin: false). The backend's CSRF
    // check compares Origin with Host, so rewriting Host to the target makes
    // every POST/PATCH/DELETE through Vite fail with "Origin does not match".
    // Use 127.0.0.1 as the target: on Windows, "localhost" often resolves to
    // ::1 while uvicorn binds to 127.0.0.1, causing ECONNREFUSED proxy 500s.
    proxy: Object.fromEntries(
      [
        "/api",
        // FastAPI Swagger / ReDoc / OpenAPI (not part of the React app).
        "/docs",
        "/redoc",
        "/openapi.json",
        // MkDocs wiki (built into backend/static/wiki or Docker image).
        "/wiki",
      ].map((path) => [
        path,
        { target: "http://127.0.0.1:8080", changeOrigin: false },
      ])
    ),
  },
});
