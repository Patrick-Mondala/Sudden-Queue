/**
 * Server-to-client push.
 *
 * Direct replacement for the earlier system's lobby-state event: one outbound
 * channel carrying a discriminated union the client switches on. The event
 * names are the contract, so they live in one place and both sides import the
 * same type.
 */

export type ServerEvent =
  | { type: "party.updated"; party: unknown }
  | { type: "party.invite.received"; invite: unknown }
  | { type: "party.invite.declined"; inviteId: string; byUserId: string }
  | { type: "queue.joined"; partyId: string; regions: string[]; joinedAt: number }
  | { type: "queue.left"; partyId: string; reason?: string }
  | { type: "queue.counts"; online: number; inQueue: number; inMatch: number }
  | { type: "match.found"; matchId: string; acceptDeadline: string; match: unknown }
  | { type: "match.accept.progress"; matchId: string; accepted: number; total: number }
  | { type: "match.state"; matchId: string; state: string; match?: unknown }
  | { type: "match.cancelled"; matchId: string; reason: string; atFault: boolean }
  | {
      type: "match.resolved";
      matchId: string;
      result: string;
      /** Rank before and after. Null while the player is still in placements. */
      tierBefore: string | null;
      tierAfter: string | null;
      placementsRemaining: number;
    }
  | { type: "chat.message"; channel: string; message: unknown }
  | { type: "notification"; level: "info" | "warn" | "error"; text: string };

export interface Connection {
  send(payload: string): void;
  close(): void;
}

/**
 * Tracks which sockets belong to which user.
 *
 * A user can hold several connections at once (two windows, a reconnect that
 * raced the old socket's close), so this is a set per user rather than a single
 * socket. Sends fan out to all of them and prune any that throw.
 */
export class Notifier {
  private readonly byUser = new Map<string, Set<Connection>>();

  add(userId: string, conn: Connection): void {
    const set = this.byUser.get(userId);
    if (set) set.add(conn);
    else this.byUser.set(userId, new Set([conn]));
  }

  remove(userId: string, conn: Connection): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.byUser.delete(userId);
  }

  isOnline(userId: string): boolean {
    return this.byUser.has(userId);
  }

  onlineCount(): number {
    return this.byUser.size;
  }

  onlineUserIds(): string[] {
    return [...this.byUser.keys()];
  }

  /** Sends to every connection a user holds. Dead sockets are dropped. */
  toUser(userId: string, event: ServerEvent): void {
    const set = this.byUser.get(userId);
    if (!set || set.size === 0) return;

    const payload = JSON.stringify(event);
    for (const conn of [...set]) {
      try {
        conn.send(payload);
      } catch {
        // A socket that throws on send is gone; stop tracking it rather than
        // letting it accumulate and slow every future broadcast.
        set.delete(conn);
      }
    }
    if (set.size === 0) this.byUser.delete(userId);
  }

  toUsers(userIds: readonly string[], event: ServerEvent): void {
    // De-duplicate: a party and a match roster can overlap.
    for (const id of new Set(userIds)) this.toUser(id, event);
  }

  broadcast(event: ServerEvent): void {
    for (const id of [...this.byUser.keys()]) this.toUser(id, event);
  }

  /** Closes and forgets every connection. Used on shutdown. */
  closeAll(): void {
    for (const set of this.byUser.values()) {
      for (const conn of set) {
        try {
          conn.close();
        } catch {
          // Already gone.
        }
      }
    }
    this.byUser.clear();
  }
}
