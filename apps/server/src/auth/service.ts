import { DEFAULT_RATING, type Result, fail, isFail, ok } from "@suddenqueue/core";
import { eq } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { playerRatings, users } from "../db/schema/index.js";
import type { DiscordAuth, DiscordProfile } from "./discord.js";
import type { SessionService } from "./sessions.js";

export interface LoginResult {
  userId: string;
  token: string;
  expiresAt: Date;
  isNewAccount: boolean;
}

/**
 * Ties Discord OAuth to accounts and sessions.
 *
 * A Discord id is the durable identity; display name and avatar are refreshed
 * on every login because people change them and a stale roster is confusing.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly discord: DiscordAuth,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Completes the OAuth callback: exchange, profile fetch, account upsert,
   * session issue.
   */
  async completeLogin(
    code: string,
    codeVerifier: string,
  ): Promise<Result<LoginResult, "TOKEN_EXCHANGE_FAILED" | "PROFILE_FETCH_FAILED" | "BANNED">> {
    const token = await this.discord.exchangeCode(code, codeVerifier);
    if (isFail(token)) return token;

    const profile = await this.discord.fetchProfile(token.data.accessToken);
    if (isFail(profile)) return profile;

    return this.loginWithProfile(profile.data);
  }

  /**
   * Account upsert plus session issue, split out so it can be driven directly
   * in tests without standing up an OAuth exchange.
   */
  async loginWithProfile(
    profile: DiscordProfile,
  ): Promise<Result<LoginResult, "BANNED">> {
    /**
     * The username, not the display name.
     *
     * Discord has two: `username` is the unique handle you are found and added
     * by, `global_name` is whatever someone felt like being called today. The
     * display name was stored here, which made this field decorative -- two
     * people can share one, it changes on a whim, and it is not what you type
     * to find somebody.
     *
     * Refreshed on every login below, so accounts that stored a display name
     * before this correct themselves the next time their owner signs in.
     */
    const displayName = profile.username;

    const upserted = await this.db
      .insert(users)
      .values({
        discordId: profile.id,
        discordName: displayName,
        avatarUrl: profile.avatarUrl,
      })
      .onConflictDoUpdate({
        target: users.discordId,
        // Refresh identity on every login; people rename themselves.
        set: {
          discordName: displayName,
          avatarUrl: profile.avatarUrl,
          lastSeenAt: new Date(),
        },
      })
      .returning({
        id: users.id,
        createdAt: users.createdAt,
        bannedUntil: users.bannedUntil,
      });

    const user = upserted[0]!;

    if (user.bannedUntil && user.bannedUntil.getTime() > Date.now()) {
      return fail("BANNED", `Account is suspended until ${user.bannedUntil.toISOString()}`);
    }

    // New accounts need a rating row before they can queue. Conflict-safe so a
    // concurrent second login cannot duplicate it.
    const inserted = await this.db
      .insert(playerRatings)
      .values({
        userId: user.id,
        rating: DEFAULT_RATING,
        peakRating: DEFAULT_RATING,
      })
      .onConflictDoNothing({ target: playerRatings.userId })
      .returning({ userId: playerRatings.userId });

    const session = await this.sessions.create(user.id);

    return ok({
      userId: user.id,
      token: session.token,
      expiresAt: session.expiresAt,
      isNewAccount: inserted.length > 0,
    });
  }

  /** Sets the player's in-game name. Unverifiable, so it is display data only. */
  async setInGameName(
    userId: string,
    name: string,
  ): Promise<Result<{ inGameName: string }, "INVALID_NAME">> {
    const trimmed = name.trim();

    if (trimmed.length < 2 || trimmed.length > 16) {
      return fail("INVALID_NAME", "In-game name must be between 2 and 16 characters");
    }

    await this.db
      .update(users)
      .set({ inGameName: trimmed })
      .where(eq(users.id, userId));

    return ok({ inGameName: trimmed });
  }

  async getUser(userId: string) {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    return row ?? null;
  }
}
