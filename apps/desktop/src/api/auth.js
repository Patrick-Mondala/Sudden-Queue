import { loginWithDiscord as startLogin, logout as apiLogout, bus } from "./client.js";

/**
 * Opens a URL in the user's real browser.
 *
 * OAuth must not happen inside the app's own webview: the user needs to see
 * the address bar to trust where they are typing their Discord password, and
 * Discord blocks embedded webviews for exactly that reason.
 *
 * Falls back to window.open when running in a plain browser during development,
 * where the Tauri plugin is not present.
 */
async function openInBrowser(url) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Runs the full desktop sign-in and brings the realtime connection up.
 * Resolves with the session token; throws an ApiError on failure or timeout.
 */
export async function signIn({ signal } = {}) {
  const token = await startLogin({ openUrl: openInBrowser, signal });
  bus.connect();
  return token;
}

export async function signOut() {
  bus.disconnect();
  await apiLogout();
}
