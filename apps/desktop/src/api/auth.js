import { loginWithDiscord as startLogin, logout as apiLogout, bus, BASE_URL } from "./client.js";
import { IS_DESKTOP } from "./shell.js";

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
  if (!IS_DESKTOP) {
    // In a browser the handoff has nothing to bridge: the tab that signs in is
    // the tab that plays. So just go, and let the callback redirect back with
    // the session already set as a cookie.
    window.location.assign(`${BASE_URL}/auth/discord/start`);

    // Never resolves, on purpose. The document is being replaced; returning
    // would let the caller clear its waiting state and paint a sign-in button
    // over a page that is already on its way to Discord.
    return new Promise(() => {});
  }

  const token = await startLogin({ openUrl: openInBrowser, signal });
  bus.connect();
  return token;
}

export async function signOut() {
  bus.disconnect();
  await apiLogout();
}
