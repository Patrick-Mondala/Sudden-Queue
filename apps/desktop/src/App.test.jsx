import { configure } from "@testing-library/dom";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every crash this file guards against reached the user as a blank window, and
 * every one of them would have died on the first render. So these tests mount
 * the real component tree against payloads shaped like the server's, rather
 * than asserting on details of what it draws.
 */

// These run alongside the server suite, which is talking to Postgres, so the
// machine can be busy enough that a one-second default times out on a render
// that is only slow, not broken.
configure({ asyncUtilTimeout: 5000 });

const listeners = new Set();

/** Stands in for the WebSocket, so a test can push what the server would. */
const liveBus = {
  on: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
};

const emit = (event) => act(() => { for (const fn of [...listeners]) fn(event); });

const server = {
  me: vi.fn(),
  history: vi.fn(),
  queueStats: vi.fn(),
  getMatch: vi.fn(),
  onlinePlayers: vi.fn(),
  invite: vi.fn(),
  getInvites: vi.fn(),
  acceptInvite: vi.fn(),
  declineInvite: vi.fn(),
  joinQueue: vi.fn(),
  leaveQueue: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  reportResult: vi.fn(),
};

let token = "test-token";

vi.mock("./api/client.js", () => ({
  api: server,
  bus: liveBus,
  getToken: () => token,
}));

vi.mock("./api/auth.js", () => ({ signIn: vi.fn() }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
    requestUserAttention: () => Promise.resolve(),
  }),
  UserAttentionType: { Critical: 1 },
}));

const { default: App } = await import("./App.jsx");

/** A placed player, shaped as the server's match view sends them. */
const player = (i, over = {}) => ({
  id: `user-${i}`,
  discordName: `Player${i}`,
  inGameName: `PLAYER_${i}`,
  avatarUrl: null,
  tier: "B",
  placementsRemaining: 0,
  gamesPlayed: 40,
  wins: 20,
  losses: 20,
  accepted: false,
  ...over,
});

const PROFILE = {
  userId: "user-1",
  discordName: "Player1",
  inGameName: "PLAYER_1",
  role: "player",
  tier: "B",
  rating: 1200,
  placementsRemaining: 0,
  gamesPlayed: 40,
  wins: 20,
  losses: 20,
  party: { partyId: "p1", leaderId: "user-1", queued: false, members: [] },
};

/** The match payload as GET /match/:id and the match.found event send it. */
const MATCH = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "PUG",
  region: "na",
  state: "PENDING_ACCEPT",
  result: null,
  acceptDeadline: new Date(Date.now() + 20_000).toISOString(),
  partyUpDeadline: null,
  reportDeadline: null,
  createdAt: new Date().toISOString(),
  team1Tier: "B",
  team2Tier: "B-",
  captain1: "user-1",
  captain2: "user-6",
  team1: [1, 2, 3, 4, 5].map((i) => player(i)),
  team2: [6, 7, 8, 9, 10].map((i) => player(i)),
};

beforeEach(() => {
  token = "test-token";
  listeners.clear();
  localStorage.clear();
  server.me.mockResolvedValue(PROFILE);
  server.history.mockResolvedValue([]);
  server.queueStats.mockResolvedValue({ online: 1, inQueue: 0, inMatch: 0 });
  server.getMatch.mockResolvedValue(MATCH);
  server.accept.mockResolvedValue({});
  server.onlinePlayers.mockResolvedValue({ players: [] });
  server.getInvites.mockResolvedValue([]);
});

afterEach(cleanup);

/** Mounts and waits for the signed-in shell. */
async function signedIn() {
  render(<App />);
  await screen.findByText(/Ready to queue/i);
}

describe("mounting", () => {
  it("renders the sign-in screen with no session", async () => {
    token = null;
    render(<App />);
    expect(await screen.findByText(/Continue with Discord/i)).toBeTruthy();
  });

  it("restores a session and renders the lobby", async () => {
    await signedIn();
    expect(screen.getByText("PLAYER_1")).toBeTruthy();
  });
});

describe("a match arriving", () => {
  it("draws both rosters from the server's payload", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });

    // The crash this replaces was `match.team1 is not iterable`: the server was
    // sending participant rows where the roster expected players.
    expect(await screen.findByText(/Match found/i)).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Accept/i })).toBeTruthy();
  });

  it("survives a payload it cannot draw, instead of blanking", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: { participants: [] } });

    expect(await screen.findByText(/could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/Ready to queue/i)).toBeTruthy();
  });

  it("reaches the match screen and names your own captain", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);

    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });

    // `cap.inGameName` crashed here once, because the captain was looked up in
    // sample data that a real match has no entry in.
    expect(await screen.findByText(/Party up/i)).toBeTruthy();
    await waitFor(() => expect(server.getMatch).toHaveBeenCalledWith(MATCH.id));
  });
});

describe("what the screen is allowed to show", () => {
  it("shows ranks and never a rating number", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);
    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });
    await screen.findByText(/Party up/i);

    // Rank is the published unit. Any four-digit number in rating range on
    // screen means one leaked back in.
    expect(document.body.textContent).not.toMatch(/\b(6[2-9]\d|[7-9]\d\d|1[0-7]\d\d)\b/);
    expect(screen.getAllByText("B").length).toBeGreaterThan(0);
  });

  it("shows an unplaced player as unranked rather than as a number", async () => {
    server.me.mockResolvedValue({ ...PROFILE, tier: null, placementsRemaining: 3, gamesPlayed: 2 });
    await signedIn();

    expect(screen.getByText(/3 placements left/i)).toBeTruthy();
  });
});

describe("inviting people", () => {
  const online = [
    { id: "user-2", discordName: "Aria", inGameName: "ARIA", tier: "B+", placementsRemaining: 0, unavailable: null },
    { id: "user-3", discordName: "Boreas", inGameName: "BOREAS", tier: null, placementsRemaining: 2, unavailable: null },
    { id: "user-4", discordName: "Cinder", inGameName: "CINDER", tier: "A", placementsRemaining: 0, unavailable: "In a party" },
  ];

  beforeEach(() => {
    server.onlinePlayers.mockResolvedValue({ players: online });
    server.invite.mockResolvedValue({});
    server.getInvites.mockResolvedValue([]);
  });

  async function openInvites() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Invite/i }));
    // The lobby has its own Invite button, so the modal is returned and every
    // query below is scoped to it rather than to the whole screen.
    return screen.findByRole("dialog", { name: /Invite to party/i });
  }

  it("lists everyone online", async () => {
    const modal = await openInvites();
    for (const p of online) expect(within(modal).getByText(p.discordName)).toBeTruthy();
  });

  it("filters as you type", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "bor");

    await waitFor(() => expect(within(modal).queryByText("Aria")).toBeNull());
    expect(within(modal).getByText("Boreas")).toBeTruthy();
  });

  it("matches on in-game name too, since that is what people are called in game", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "CINDER");

    await waitFor(() => expect(within(modal).queryByText("Aria")).toBeNull());
    expect(within(modal).getByText("Cinder")).toBeTruthy();
  });

  it("shows someone already in a party without an Invite button", async () => {
    const modal = await openInvites();
    expect(within(modal).getByText("In a party")).toBeTruthy();
    // Two invitable players, so two buttons.
    expect(within(modal).getAllByRole("button", { name: /^Invite$/ })).toHaveLength(2);
  });

  it("puts a player on cooldown after inviting them", async () => {
    const modal = await openInvites();
    await userEvent.click(within(modal).getAllByRole("button", { name: /^Invite$/ })[0]);

    await waitFor(() => expect(server.invite).toHaveBeenCalledWith("user-2"));
    // The button explains itself rather than waiting to be refused.
    expect(await within(modal).findByRole("button", { name: /\d+s/ })).toBeTruthy();
  });

  it("takes the wait from the server when it refuses", async () => {
    server.invite.mockRejectedValue(
      Object.assign(new Error("You invited them just now — try again in 42s"), { status: 429 }),
    );
    const modal = await openInvites();
    await userEvent.click(within(modal).getAllByRole("button", { name: /^Invite$/ })[0]);

    expect(await within(modal).findByRole("button", { name: /4[12]s/ })).toBeTruthy();
  });
});

describe("receiving invites", () => {
  const invite = (n, seconds = 30) => ({
    inviteId: `inv-${n}`,
    partyId: `party-${n}`,
    fromUserId: `user-${n}`,
    fromName: `Inviter${n}`,
    fromTier: "B",
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
  });

  beforeEach(() => {
    server.getInvites.mockResolvedValue([]);
    server.acceptInvite.mockResolvedValue({});
    server.declineInvite.mockResolvedValue({});
  });

  it("shows a toast without blocking the screen underneath", async () => {
    await signedIn();
    emit({ type: "party.invite.received", invite: invite(2) });

    expect(await screen.findByText("Inviter2")).toBeTruthy();
    // The lobby is still there and still usable behind it.
    expect(screen.getByText(/Ready to queue/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Queue/i })).toBeTruthy();
  });

  it("stacks several at once and counts the overflow", async () => {
    await signedIn();
    for (const n of [2, 3, 4, 5, 6]) emit({ type: "party.invite.received", invite: invite(n) });

    // Being invited by five people at once is ordinary, so the stack is capped
    // and the rest are counted rather than dropped.
    expect(await screen.findByText("Inviter2")).toBeTruthy();
    expect(screen.getByText("Inviter4")).toBeTruthy();
    expect(screen.queryByText("Inviter5")).toBeNull();
    expect(screen.getByText(/\+2 more invites waiting/i)).toBeTruthy();
  });

  it("ignores a duplicate arriving over a reconnect", async () => {
    await signedIn();
    emit({ type: "party.invite.received", invite: invite(2) });
    emit({ type: "party.invite.received", invite: invite(2) });

    await waitFor(() => expect(screen.getAllByText("Inviter2")).toHaveLength(1));
  });

  it("accepting one clears the rest, because you are now in a party", async () => {
    await signedIn();
    emit({ type: "party.invite.received", invite: invite(2) });
    emit({ type: "party.invite.received", invite: invite(3) });

    await userEvent.click((await screen.findAllByRole("button", { name: /Join/i }))[0]);

    await waitFor(() => expect(server.acceptInvite).toHaveBeenCalledWith("inv-2"));
    await waitFor(() => expect(screen.queryByText("Inviter3")).toBeNull());
  });

  it("declining removes only that one", async () => {
    await signedIn();
    emit({ type: "party.invite.received", invite: invite(2) });
    emit({ type: "party.invite.received", invite: invite(3) });

    await userEvent.click((await screen.findAllByRole("button", { name: /Decline/i }))[0]);

    await waitFor(() => expect(screen.queryByText("Inviter2")).toBeNull());
    expect(screen.getByText("Inviter3")).toBeTruthy();
  });

  it("drops an invite once it expires", async () => {
    await signedIn();
    emit({ type: "party.invite.received", invite: invite(2, 1) });
    expect(await screen.findByText("Inviter2")).toBeTruthy();

    await waitFor(() => expect(screen.queryByText("Inviter2")).toBeNull(), { timeout: 4000 });
  });
});

describe("missing a match", () => {
  /**
   * The lobby has a standing line about cooldowns in its help text, so these
   * match the heading exactly rather than anywhere the word appears.
   */
  const HEADING = "On cooldown";

  it("locks the queue for as long as the server says", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);

    emit({
      type: "match.cancelled",
      matchId: MATCH.id,
      reason: "ACCEPT_TIMEOUT",
      atFault: true,
      cooldownSeconds: 300,
    });

    expect(await screen.findByText(HEADING)).toBeTruthy();
    // The countdown is the server's number, not one the client picked.
    expect(screen.getByText("5:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Queue/i }).disabled).toBe(true);
  });

  it("does not punish you for someone else's no-show", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);

    emit({
      type: "match.cancelled",
      matchId: MATCH.id,
      reason: "ACCEPT_TIMEOUT",
      atFault: false,
      cooldownSeconds: 0,
    });

    expect(await screen.findByText(/didn't accept/i)).toBeTruthy();
    expect(screen.queryByText(HEADING)).toBeNull();
    expect(screen.getByRole("button", { name: /Queue/i }).disabled).toBe(false);
  });

  it("still knows about a cooldown after a reload", async () => {
    server.me.mockResolvedValue({ ...PROFILE, queueCooldownSeconds: 120 });
    render(<App />);

    // Otherwise the lobby offers a queue button the server will refuse. Note
    // this cannot wait for the usual signed-in marker: the heading it would
    // wait for is the very thing the cooldown replaces.
    expect(await screen.findByText(HEADING)).toBeTruthy();
    expect(screen.getByText("2:00")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Queue/i }).disabled).toBe(true);
  });
});
