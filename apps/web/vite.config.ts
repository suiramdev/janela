import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: true,
    proxy: {
      "/ws": { target: "ws://127.0.0.1:7411", ws: true },
    },
  },
  worker: { format: "es" },
  build: {
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
});
