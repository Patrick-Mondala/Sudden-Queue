import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { type Result, fail, ok } from "@suddenqueue/core";
import { and, eq, gt, lt, or } from "drizzle-orm";

import type { Database } from "../db/client.js";
import { sessions, users } from "../db/schema/index.js";

/** How long a session stays valid without being refreshed. */
export const SESSION_TTL_DAYS = 30;

export interface SessionUser {
  userId: string;
  discordId: string;
  discordName: string;
  inGameName: string | null;
  role: "player" | "game_master" | "admin";
}

/**
 * Session issuing and verification.
 *
 * The raw token is returned to the caller exactly once and never stored. The
 * database holds only its SHA-256 hash, so a leaked database dump cannot be
 * replayed as a set of live logins.
 */
export class SessionService {
  constructor(private readonly db: Database) {}

  private static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /** Issues a session. The returned token is the only copy. */
  async create(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    await this.db.insert(sessions).values({
      userId,
      tokenHash: SessionService.hash(token),
      expiresAt,
    });

    return { token, expiresAt };
  }

  /**
   * Resolves a token to its user, or fails with why it was rejected.
   *
   * Looks up by hash rather than scanning, so this is a single indexed read and
   * there is no timing signal to exploit in the lookup itself.
   */
  async verify(
    token: string,
  ): Promise<Result<SessionUser, "INVALID_SESSION" | "SESSION_EXPIRED" | "SESSION_REVOKED">> {
    if (!token) return fail("INVALID_SESSION", "No session token supplied");

    const [row] = await this.db
      .select({
        sessionId: sessions.id,
        expiresAt: sessions.expiresAt,
        revoked: sessions.revoked,
        userId: users.id,
        discordId: users.discordId,
        discordName: users.discordName,
        inGameName: users.inGameName,
        role: users.role,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, SessionService.hash(token)))
      .limit(1);

    if (!row) return fail("INVALID_SESSION", "Session not found");
    if (row.revoked) return fail("SESSION_REVOKED", "Session was revoked");
    if (row.expiresAt.getTime() <= Date.now()) {
      return fail("SESSION_EXPIRED", "Session has expired");
    }

    return ok({
      userId: row.userId,
      discordId: row.discordId,
      discordName: row.discordName,
      inGameName: row.inGameName,
      role: row.role,
    });
  }

  /** Revokes a single session (sign out on this device). */
  async revoke(token: string): Promise<boolean> {
    const rows = await this.db
      .update(sessions)
      .set({ revoked: true })
      .where(eq(sessions.tokenHash, SessionService.hash(token)))
      .returning({ id: sessions.id });

    return rows.length > 0;
  }

  /** Revokes every session for a user (sign out everywhere, or a ban). */
  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(sessions)
      .set({ revoked: true })
      .where(and(eq(sessions.userId, userId), eq(sessions.revoked, false)))
      .returning({ id: sessions.id });

    return rows.length;
  }

  /** Deletes expired and revoked rows. Housekeeping, safe to run on a timer. */
  async prune(): Promise<number> {
    const rows = await this.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, new Date()), eq(sessions.revoked, true)))
      .returning({ id: sessions.id });

    return rows.length;
  }

  async activeCountForUser(userId: string): Promise<number> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.revoked, false),
          gt(sessions.expiresAt, new Date()),
        ),
      );

    return rows.length;
  }
}

/**
 * Constant-time string comparison for secrets compared outside the database,
 * such as the OAuth state parameter.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
