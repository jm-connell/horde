import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["shaka-player/dist/shaka-player.dash.js"],
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
