import { createHash, createHmac, randomBytes } from "node:crypto";

import { type Result, fail, ok } from "@suddenqueue/core";

import { safeEqual } from "./sessions.js";

const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";
const DISCORD_TOKEN = "https://discord.com/api/oauth2/token";
const DISCORD_ME = "https://discord.com/api/users/@me";

export interface DiscordProfile {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string | null;
}

export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Signs the state parameter. Reuses SESSION_SECRET. */
  stateSecret: string;
}

/** Injected so tests do not reach the network. */
export type Fetcher = typeof fetch;

/**
 * Discord OAuth2, authorization-code flow with PKCE.
 *
 * PKCE matters here beyond convention: the desktop client cannot keep a secret,
 * so the code verifier is what stops an intercepted authorization code from
 * being redeemed by anything other than the app that started the flow.
 */
export class DiscordAuth {
  constructor(
    private readonly config: DiscordConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  /**
   * Builds the URL to send the user to, plus the verifier to keep until the
   * callback returns.
   *
   * State is HMAC-signed rather than stored, so it survives a restart and needs
   * no cleanup, while still being unforgeable and bound to this deployment.
   */
  createAuthorizationUrl(payload: Record<string, string> = {}): {
    url: string;
    state: string;
    codeVerifier: string;
  } {
    const nonce = randomBytes(16).toString("base64url");
    const body = JSON.stringify({ nonce, iat: Date.now(), ...payload });
    const encoded = Buffer.from(body).toString("base64url");
    const signature = createHmac("sha256", this.config.stateSecret)
      .update(encoded)
      .digest("base64url");
    const state = `${encoded}.${signature}`;

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

    const url = new URL(DISCORD_AUTHORIZE);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), state, codeVerifier };
  }

  /**
   * Verifies a returned state parameter and extracts its payload.
   * Rejects anything unsigned, tampered with, or older than `maxAgeMs`.
   */
  verifyState(
    state: string,
    maxAgeMs = 10 * 60 * 1000,
  ): Result<Record<string, unknown>, "BAD_STATE" | "STATE_EXPIRED"> {
    const parts = state.split(".");
    if (parts.length !== 2) return fail("BAD_STATE", "Malformed state parameter");

    const [encoded, signature] = parts as [string, string];
    const expected = createHmac("sha256", this.config.stateSecret)
      .update(encoded)
      .digest("base64url");

    if (!safeEqual(signature, expected)) {
      return fail("BAD_STATE", "State signature did not match");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64url").toString());
    } catch {
      return fail("BAD_STATE", "State payload was not valid JSON");
    }

    const iat = typeof parsed.iat === "number" ? parsed.iat : 0;
    if (Date.now() - iat > maxAgeMs) {
      return fail("STATE_EXPIRED", "Authorization request took too long");
    }

    return ok(parsed);
  }

  /** Exchanges an authorization code for an access token. */
  async exchangeCode(
    code: string,
    codeVerifier: string,
  ): Promise<Result<{ accessToken: string }, "TOKEN_EXCHANGE_FAILED">> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });

    let response: Response;
    try {
      response = await this.fetcher(DISCORD_TOKEN, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      return fail("TOKEN_EXCHANGE_FAILED", `Could not reach Discord: ${String(err)}`);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      return fail(
        "TOKEN_EXCHANGE_FAILED",
        `Discord rejected the authorization code (${response.status})`,
        detail,
      );
    }

    const json = (await response.json()) as { access_token?: string };
    if (!json.access_token) {
      return fail("TOKEN_EXCHANGE_FAILED", "Discord response had no access token");
    }

    return ok({ accessToken: json.access_token });
  }

  /** Fetches the authenticated user's profile. */
  async fetchProfile(
    accessToken: string,
  ): Promise<Result<DiscordProfile, "PROFILE_FETCH_FAILED">> {
    let response: Response;
    try {
      response = await this.fetcher(DISCORD_ME, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch (err) {
      return fail("PROFILE_FETCH_FAILED", `Could not reach Discord: ${String(err)}`);
    }

    if (!response.ok) {
      return fail("PROFILE_FETCH_FAILED", `Discord returned ${response.status}`);
    }

    const json = (await response.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };

    if (!json.id || !json.username) {
      return fail("PROFILE_FETCH_FAILED", "Discord profile was missing required fields");
    }

    return ok({
      id: json.id,
      username: json.username,
      globalName: json.global_name ?? null,
      avatarUrl: json.avatar
        ? `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.png`
        : null,
    });
  }
}
