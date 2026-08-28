import {
  CHAT_MAX_MESSAGE_LENGTH,
  CHAT_MAX_STORED_MESSAGES,
  CHAT_RATE_LIMIT,
  CHAT_RATE_WINDOW_SECONDS,
  isFail,
  isOk,
} from "@suddenqueue/core";
import { beforeEach, describe, expect, it } from "vitest";

import { ChatService, chatChannels } from "./service.js";

let chat: ChatService;
const author = { userId: "user-1", discordName: "Player1", isGameMaster: false };
const other = { userId: "user-2", discordName: "Player2", isGameMaster: true };

beforeEach(() => {
  chat = new ChatService();
});

describe("posting", () => {
  it("keeps what was said, in order", async () => {
    chat.post("party:p1", author, "first");
    chat.post("party:p1", other, "second");

    const history = chat.history("party:p1");
    expect(history.map((m) => m.text)).toEqual(["first", "second"]);
    expect(history[0]!.discordName).toBe("Player1");
  });

  it("trims, and refuses a message that is only whitespace", async () => {
    const padded = chat.post("party:p1", author, "  hello  ");
    expect(isOk(padded)).toBe(true);
    if (isOk(padded)) expect(padded.data.text).toBe("hello");

    const empty = chat.post("party:p1", author, "   ");
    expect(isFail(empty)).toBe(true);
    if (isFail(empty)) expect(empty.code).toBe("EMPTY");
  });

  it("refuses one that is too long", async () => {
    const res = chat.post("party:p1", author, "x".repeat(CHAT_MAX_MESSAGE_LENGTH + 1));
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("TOO_LONG");
  });

  it("keeps channels apart", async () => {
    chat.post("party:p1", author, "party talk");
    chat.post("match:m1", author, "match talk");

    expect(chat.history("party:p1").map((m) => m.text)).toEqual(["party talk"]);
    expect(chat.history("match:m1").map((m) => m.text)).toEqual(["match talk"]);
  });
});

describe("the buffer", () => {
  it("drops the oldest rather than growing without bound", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_MAX_STORED_MESSAGES + 20; i += 1) {
      // Stepped past the rate window each time; the cap is what is under test.
      chat.post("match:m1", author, `line ${i}`, now + i * CHAT_RATE_WINDOW_SECONDS * 1000);
    }

    const history = chat.history("match:m1");
    expect(history).toHaveLength(CHAT_MAX_STORED_MESSAGES);
    expect(history[0]!.text).toBe("line 20");
    expect(history.at(-1)!.text).toBe(`line ${CHAT_MAX_STORED_MESSAGES + 19}`);
  });

  it("hands back only what was asked for", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i += 1) {
      chat.post("match:m1", author, `line ${i}`, now + i * CHAT_RATE_WINDOW_SECONDS * 1000);
    }

    const tail = chat.history("match:m1", 3);
    expect(tail.map((m) => m.text)).toEqual(["line 7", "line 8", "line 9"]);
  });

  it("is empty for a channel nobody has used", async () => {
    expect(chat.history("match:nothing")).toEqual([]);
  });
});

describe("the rate limit", () => {
  it("allows a burst and then holds", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_RATE_LIMIT; i += 1) {
      expect(isOk(chat.post("party:p1", author, `line ${i}`, now))).toBe(true);
    }

    const blocked = chat.post("party:p1", author, "one more", now);
    expect(isFail(blocked)).toBe(true);
    if (isFail(blocked)) expect(blocked.code).toBe("RATE_LIMITED");
  });

  it("frees up once the window passes", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_RATE_LIMIT; i += 1) chat.post("party:p1", author, `line ${i}`, now);

    const later = now + CHAT_RATE_WINDOW_SECONDS * 1000 + 1;
    expect(isOk(chat.post("party:p1", author, "later", later))).toBe(true);
  });

  it("counts the person, not the channel", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_RATE_LIMIT; i += 1) chat.post("party:p1", author, `line ${i}`, now);

    // Otherwise switching tabs buys a fresh allowance.
    const elsewhere = chat.post("match:m1", author, "same person", now);
    expect(isFail(elsewhere)).toBe(true);
  });

  it("is not shared between people", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_RATE_LIMIT; i += 1) chat.post("party:p1", author, `line ${i}`, now);

    expect(isOk(chat.post("party:p1", other, "unaffected", now))).toBe(true);
  });

  it("is forgotten when they disconnect", async () => {
    const now = Date.now();
    for (let i = 0; i < CHAT_RATE_LIMIT; i += 1) chat.post("party:p1", author, `line ${i}`, now);

    chat.forget(author.userId);
    expect(isOk(chat.post("party:p1", author, "back again", now))).toBe(true);
  });
});

describe("clearing up", () => {
  it("takes all three of a match's channels together", async () => {
    chat.post(chatChannels.match("m1"), author, "all");
    chat.post(chatChannels.team("m1", 1), author, "ours");
    chat.post(chatChannels.team("m1", 2), other, "theirs");
    chat.post(chatChannels.party("p1"), author, "party");

    chat.clearMatch("m1");

    expect(chat.history(chatChannels.match("m1"))).toEqual([]);
    expect(chat.history(chatChannels.team("m1", 1))).toEqual([]);
    expect(chat.history(chatChannels.team("m1", 2))).toEqual([]);
    // The party outlives the match, and so does what was said in it.
    expect(chat.history(chatChannels.party("p1"))).toHaveLength(1);
  });
});

describe("channel names", () => {
  it("derive from the thing they belong to, so none can be invented", async () => {
    expect(chatChannels.party("p1")).toBe("party:p1");
    expect(chatChannels.match("m1")).toBe("match:m1");
    expect(chatChannels.team("m1", 2)).toBe("match:m1:t2");
  });
});
