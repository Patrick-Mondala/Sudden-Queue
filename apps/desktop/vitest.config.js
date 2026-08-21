import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Render tests for the client.
 *
 * These exist because three crashes shipped as a blank window -- an undefined
 * identifier, a temporal dead zone, and a payload the roster could not draw --
 * and every one of them would have been caught by mounting the app once. A
 * build cannot find them: all three are legal JavaScript until they run.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.jsx"],
    restoreMocks: true,
  },
});
