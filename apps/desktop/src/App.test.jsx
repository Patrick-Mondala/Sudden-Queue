import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every crash this file guards against reached the user as a blank window, and
 * every one of them would have died on the first render. So these tests mount
 * the real component tree against payloads shaped like the server's, rather
 * than asserting on details of what it draws.
 */

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
    expect(screen.getByRole("button", { name: /Accept/i })).toBeTruthy();
    expect(screen.getByText(/PUG · NA · 5v5/)).toBeTruthy();
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
    await waitFor(() => expect(screen.getByText(/Party up/i)).toBeTruthy());
    expect(server.getMatch).toHaveBeenCalledWith(MATCH.id);
  });
});

describe("what the screen is allowed to show", () => {
  it("shows ranks and never a rating number", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);
    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });
    await waitFor(() => expect(screen.getByText(/Party up/i)).toBeTruthy());

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
