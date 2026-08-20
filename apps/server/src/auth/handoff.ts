import { randomBytes } from "node:crypto";

/**
 * Desktop login handoff.
 *
 * The Tauri app cannot receive Discord's redirect itself, so OAuth completes in
 * the user's browser against this server. The app opens the browser with a
 * handoff id, then polls for the session that lands against it.
 *
 * Entries are single-use and short-lived, and live in memory deliberately: a
 * restart mid-login should invalidate the attempt rather than leave a claimable
 * token lying in a table.
 */

export interface HandoffEntry {
  token?: string;
  expiresAt: number;
  error?: string;
}

const TTL_MS = 10 * 60 * 1000;

export class LoginHandoff {
  private readonly pending = new Map<string, HandoffEntry>();

  create(): string {
    this.sweep();
    const id = randomBytes(18).toString("base64url");
    this.pending.set(id, { expiresAt: Date.now() + TTL_MS });
    return id;
  }

  /** True if the id is a live, unclaimed handoff. */
  isOpen(id: string): boolean {
    const entry = this.pending.get(id);
    return entry !== undefined && entry.expiresAt > Date.now();
  }

  fulfill(id: string, token: string): void {
    const entry = this.pending.get(id);
    if (!entry || entry.expiresAt <= Date.now()) return;
    entry.token = token;
  }

  /** Records a failed login so the app can stop polling and say why. */
  reject(id: string, error: string): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.error = error;
  }

  /**
   * Claims the session. Single-use: the entry is dropped on the first
   * successful read so a replayed poll cannot hand the token out twice.
   */
  claim(id: string): { status: "pending" } | { status: "ready"; token: string } | { status: "error"; error: string } | { status: "expired" } {
    this.sweep();
    const entry = this.pending.get(id);

    if (!entry) return { status: "expired" };
    if (entry.error) {
      this.pending.delete(id);
      return { status: "error", error: entry.error };
    }
    if (!entry.token) return { status: "pending" };

    this.pending.delete(id);
    return { status: "ready", token: entry.token };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }

  get size(): number {
    return this.pending.size;
  }
}
