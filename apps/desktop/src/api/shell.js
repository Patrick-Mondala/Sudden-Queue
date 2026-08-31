/**
 * Which shell this bundle is running in.
 *
 * The same code ships twice: inside the Tauri window, and as a website served
 * from the deployment it talks to. They differ in how sign-in works, whether
 * an updater exists, and whether the window can demand attention. Naming the
 * difference once, here, keeps those three from each deciding it a slightly
 * different way and disagreeing.
 *
 * Detected rather than compiled in. `import.meta.env.DEV` was the old stand-in
 * and it only ever worked by coincidence -- it means "not a production build",
 * which stopped being the same question the moment there was a production
 * build that is not the desktop app.
 *
 * Tauri injects its IPC bridge onto `window` before any of this runs, so its
 * presence is the shell itself and not an inference about it.
 */
export const IS_DESKTOP =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** True in a plain browser, including `npm run dev` without the Tauri window. */
export const IS_WEB = !IS_DESKTOP;
