import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the FastAPI app runs on :8000 (uvicorn api.main:app --reload); Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8000" } },
});
