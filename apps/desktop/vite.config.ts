import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Port and strictPort must agree with `build.devUrl` in src-tauri/tauri.conf.json:
// the Tauri CLI waits for that exact URL before it starts cargo.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    // WKWebView on the macOS 15 floor (tauri.conf.json § bundle.macOS).
    target: "safari18",
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
});
