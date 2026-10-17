/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { hordeServiceWorker } from "./vite-plugin-sw";

export default defineConfig({
  plugins: [react(), hordeServiceWorker()],
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
    proxy: {
      // Use 127.0.0.1 — on Windows, "localhost" often resolves to ::1 while
      // uvicorn binds to 127.0.0.1, causing ECONNREFUSED proxy 500s.
      "/api": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      // FastAPI Swagger / ReDoc / OpenAPI (not part of the React app).
      "/docs": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/redoc": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      "/openapi.json": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
      // MkDocs wiki (built into backend/static/wiki or Docker image).
      "/wiki": {
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
