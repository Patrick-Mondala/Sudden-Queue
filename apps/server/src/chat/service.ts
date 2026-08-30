import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_SECONDS,
  type Result,
  fail,
  ok,
} from "@suddenqueue/core";

export interface ChatMessage {
  id: string;
  channel: string;
  userId: string;
  discordName: string;
  inGameName: string | null;
  avatarUrl: string | null;
  isGameMaster: boolean;
  text: string;
  ts: number;
}

export type ChatError = "EMPTY" | "TOO_LONG" | "RATE_LIMITED";

/**
 * Channel names.
 *
 * A channel is derived from the thing it belongs to rather than stored, so
 * there is nothing to create, nothing to clean up, and no way to name a channel
 * that does not correspond to something real.
 */
export const chatChannels = {
  party: (partyId: string) => `party:${partyId}`,
  match: (matchId: string) => `match:${matchId}`,
  team: (matchId: string, team: 1 | 2) => `match:${matchId}:t${team}`,
};

/**
 * Chat, held in memory and never written down.
 *
 * The things people talk in here -- a party, a match -- do not outlive the
 * process by much, and the original design said as much on screen: chat is not
 * saved. Keeping it that way means no retention policy, no moderation archive
 * nobody asked for, and no schema to migrate when the shape changes.
 *
 * What that costs is honest and small: a server restart empties every channel,
 * and a second server would not share them. Both are fine for one process
 * serving a lobby, and neither is hidden from the player -- the panel says it.
 */
export class ChatService {
  private readonly buffers = new Map<string, ChatMessage[]>();
  private readonly recent = new Map<string, number[]>();
  private sequence = 0;

  history(channel: string, limit = CHAT_MAX_STORED_MESSAGES): ChatMessage[] {
    const all = this.buffers.get(channel) ?? [];
    return all.slice(Math.max(0, all.length - limit));
  }

  post(
    channel: string,
    author: {
      userId: string;
      discordName: string;
      inGameName?: string | null;
      avatarUrl?: string | null;
      isGameMaster: boolean;
    },
    text: string,
    now = Date.now(),
  ): Result<ChatMessage, ChatError> {
    const trimmed = text.trim();
    if (trimmed.length === 0) return fail("EMPTY", "Say something first");
    if (trimmed.length > CHAT_MAX_MESSAGE_LENGTH) {
      return fail("TOO_LONG", `Keep it under ${CHAT_MAX_MESSAGE_LENGTH} characters`);
    }

    // Per person rather than per channel: the limit is on someone flooding, and
    // switching tabs should not buy them a fresh allowance.
    const window = now - CHAT_RATE_WINDOW_SECONDS * 1000;
    const stamps = (this.recent.get(author.userId) ?? []).filter((t) => t > window);

    if (stamps.length >= CHAT_RATE_LIMIT) {
      this.recent.set(author.userId, stamps);
      return fail("RATE_LIMITED", "Slow down a moment");
    }

    stamps.push(now);
    this.recent.set(author.userId, stamps);

    this.sequence += 1;
    const message: ChatMessage = {
      id: `m${this.sequence}`,
      channel,
      userId: author.userId,
      discordName: author.discordName,
      inGameName: author.inGameName ?? null,
      avatarUrl: author.avatarUrl ?? null,
      isGameMaster: author.isGameMaster,
      text: trimmed,
      ts: now,
    };

    const buffer = this.buffers.get(channel) ?? [];
    buffer.push(message);
    // Oldest out first: a long match should not grow without bound.
    if (buffer.length > CHAT_MAX_STORED_MESSAGES) {
      buffer.splice(0, buffer.length - CHAT_MAX_STORED_MESSAGES);
    }
    this.buffers.set(channel, buffer);

    return ok(message);
  }

  /** Drops a channel once whatever it belonged to is over. */
  clear(channel: string): void {
    this.buffers.delete(channel);
  }

  /** Everything for one match: both team channels and the shared one. */
  clearMatch(matchId: string): void {
    this.clear(chatChannels.match(matchId));
    this.clear(chatChannels.team(matchId, 1));
    this.clear(chatChannels.team(matchId, 2));
  }

  /** Forgets a player's rate-limit history, on disconnect. */
  forget(userId: string): void {
    this.recent.delete(userId);
  }
}
