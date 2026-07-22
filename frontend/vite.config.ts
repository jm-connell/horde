import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["shaka-player/dist/shaka-player.dash.js"],
  },
  server: {
    proxy: {
      "/api": {
        // Use 127.0.0.1 — on Windows, "localhost" often resolves to ::1 while
        // uvicorn binds to 127.0.0.1, causing ECONNREFUSED proxy 500s.
        target: "http://127.0.0.1:8080",
        changeOrigin: true,
      },
    },
  },
});
