/**
 * Update checking.
 *
 * Only the bundled desktop app can update itself. The same client also runs in
 * a plain browser during development, where these plugins do not exist -- so
 * the shell is detected rather than assumed, and everything degrades to "no
 * update available" instead of throwing at import time.
 */

/** Resolves the plugin, or null when running outside the desktop shell. */
async function updater() {
  try {
    return await import("@tauri-apps/plugin-updater");
  } catch {
    return null;
  }
}

/**
 * Asks whether a newer version has been published.
 *
 * Returns null when there is nothing to install, or when this is not the
 * desktop app. A network failure throws, so a check the user asked for can say
 * what went wrong -- a silent "you are up to date" would be a lie.
 */
export async function checkForUpdate() {
  const mod = await updater();
  if (!mod) return null;

  const found = await mod.check();
  if (!found) return null;

  return {
    version: found.version,
    notes: found.body ?? null,
    date: found.date ?? null,
    /** The plugin's own handle. Kept opaque; only install() touches it. */
    handle: found,
  };
}

/**
 * Downloads and installs, then restarts into the new version.
 *
 * Does not return in the normal case: the relaunch replaces this process.
 * `onProgress` receives a 0..1 fraction, or null while the total size is
 * unknown, which is how the plugin reports a download without a content length.
 */
export async function installUpdate(update, onProgress) {
  let total = 0;
  let seen = 0;

  await update.handle.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data?.contentLength ?? 0;
      onProgress?.(total ? 0 : null);
    } else if (event.event === "Progress") {
      seen += event.data?.chunkLength ?? 0;
      onProgress?.(total ? Math.min(1, seen / total) : null);
    } else if (event.event === "Finished") {
      onProgress?.(1);
    }
  });

  const process = await import("@tauri-apps/plugin-process");
  await process.relaunch();
}
