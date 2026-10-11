import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (bun run dev in the repo root);
// in containers Traefik serves both under one origin.
const api = process.env.SOULCLOUD_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: api, changeOrigin: true },
      "/openapi.json": { target: api, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
