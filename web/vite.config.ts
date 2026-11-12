import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the FastAPI app runs on :8000 (uvicorn api.main:app --reload); Vite proxies /api to it.
// VITE_BASE: the path the site is served from, e.g. "/Deadlock-Power-Curves/" on GitHub Pages.
export default defineConfig(({ mode }) => ({
  base: loadEnv(mode, ".", "VITE_").VITE_BASE || "/",
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8000" } },
}));
