import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

/**
 * The version this build calls itself, taken from the one file that decides it.
 *
 * tauri.conf.json is what names the installer, what the updater compares
 * against, and what CI refuses to release under a disagreeing tag. Reading it
 * here rather than declaring the version a second time means the number the
 * client sends to the server cannot drift from the number it was built as --
 * and that number is what a deployment's version floor is checked against.
 */
const APP_VERSION = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).version;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(APP_VERSION),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
