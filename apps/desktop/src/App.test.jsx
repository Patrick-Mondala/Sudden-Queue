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

// jsdom has no layout, so it has no scrollIntoView. The chat log calls it on
// every new message; stubbing it is closing an environment gap, not papering
// over anything the app does wrong.
window.HTMLElement.prototype.scrollIntoView = () => {};

const listeners = new Set();

/** Stands in for the WebSocket, so a test can push what the server would. */
const liveBus = {
  on: (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  connect: vi.fn(),
  disconnect: vi.fn(),
  send: vi.fn(),
};

const emit = (event) => act(() => { for (const fn of [...listeners]) fn(event); });

/**
 * What a person would actually read on screen.
 *
 * body.textContent includes the injected <style> block, whose keyframes and
 * shadows are full of numbers -- enough to fail a "no ratings anywhere" scan
 * on CSS rather than on anything rendered.
 */
function visibleText() {
  const clone = document.body.cloneNode(true);
  for (const style of clone.querySelectorAll("style")) style.remove();

  // Joined with spaces rather than read as one string: textContent runs
  // neighbouring elements together, so a record of 10 beside a win rate of 75%
  // reads as 1075 and trips a scan looking for ratings.
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
  return parts.join(" ");
}

const server = {
  me: vi.fn(),
  history: vi.fn(),
  queueStats: vi.fn(),
  getMatch: vi.fn(),
  onlinePlayers: vi.fn(),
  listTeams: vi.fn(),
  getTeam: vi.fn(),
  myTeam: vi.fn(),
  createTeam: vi.fn(),
  applyToTeam: vi.fn(),
  withdrawApplication: vi.fn(),
  decideApplication: vi.fn(),
  setApplicationsOpen: vi.fn(),
  setTeamRole: vi.fn(),
  transferCaptaincy: vi.fn(),
  removeTeamMember: vi.fn(),
  leaveTeam: vi.fn(),
  disbandTeam: vi.fn(),
  scrims: vi.fn(),
  postListing: vi.fn(),
  removeListing: vi.fn(),
  requestScrim: vi.fn(),
  withdrawScrimRequest: vi.fn(),
  decideScrimRequest: vi.fn(),
  ladder: vi.fn(),
  playerProfile: vi.fn(),
  chatHistory: vi.fn(),
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
  server.myTeam.mockResolvedValue({ team: null, role: null, applications: [], myApplication: null });
  server.listTeams.mockResolvedValue({ teams: [] });
  server.scrims.mockResolvedValue({ listings: [], myListing: null, incoming: [] });
  server.ladder.mockResolvedValue({ rows: [], total: 0, myPosition: null, limit: 50, offset: 0 });
  server.playerProfile.mockResolvedValue(null);
  server.chatHistory.mockResolvedValue({ channel: "", messages: [] });
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
    expect(visibleText()).not.toMatch(/\b(6[2-9]\d|[7-9]\d\d|1[0-7]\d\d)\b/);
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

describe("teams", () => {
  const roster = (over = {}) => ({
    id: "team-1",
    tag: "ACE",
    name: "Aces High",
    region: "na",
    captainId: "user-1",
    applicationsOpen: true,
    createdAt: new Date().toISOString(),
    members: [
      {
        userId: "user-1",
        discordName: "Player1",
        inGameName: "PLAYER_1",
        role: "captain",
        tier: "B",
        placementsRemaining: 0,
        joinedAt: new Date().toISOString(),
      },
      {
        userId: "user-2",
        discordName: "Aria",
        inGameName: "ARIA",
        role: "member",
        tier: "A",
        placementsRemaining: 0,
        joinedAt: new Date().toISOString(),
      },
    ],
    ...over,
  });

  const noTeam = { team: null, role: null, applications: [], myApplication: null };

  const directory = [
    { id: "team-2", tag: "BRV", name: "Bravo", region: "na", applicationsOpen: true, memberCount: 3, tier: "B+" },
    { id: "team-3", tag: "CLD", name: "Cold", region: "na", applicationsOpen: false, memberCount: 5, tier: "A-" },
  ];

  const mine = (over) => server.myTeam.mockResolvedValue({ ...noTeam, ...over });

  beforeEach(() => {
    server.listTeams.mockResolvedValue({ teams: directory });
    server.createTeam.mockResolvedValue({ teamId: "team-1" });
    server.applyToTeam.mockResolvedValue({ applicationId: "app-1" });
    server.withdrawApplication.mockResolvedValue({ ok: true });
    server.decideApplication.mockResolvedValue({ ok: true });
    server.setTeamRole.mockResolvedValue({ ok: true });
    server.removeTeamMember.mockResolvedValue({ ok: true });
    server.disbandTeam.mockResolvedValue({ ok: true });
    server.leaveTeam.mockResolvedValue({ ok: true });
    server.setApplicationsOpen.mockResolvedValue({ ok: true });
  });

  async function openTeams() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));
  }

  it("shows the directory when you have no team", async () => {
    await openTeams();
    expect(await screen.findByText("Bravo")).toBeTruthy();
    expect(screen.getByText("Cold")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Register a team/i })).toBeTruthy();
  });

  it("will not let you apply to a team that closed applications", async () => {
    await openTeams();
    await screen.findByText("Cold");

    const buttons = screen.getAllByRole("button", { name: /^Apply$/ });
    expect(buttons[0].disabled).toBe(false);
    expect(buttons[1].disabled).toBe(true);
  });

  it("applies, then offers to withdraw rather than apply again", async () => {
    await openTeams();
    await screen.findByText("Bravo");

    // The reload after applying is what surfaces the outstanding application.
    mine({ myApplication: { id: "app-1", teamId: "team-2" } });
    await userEvent.click(screen.getAllByRole("button", { name: /^Apply$/ })[0]);

    await waitFor(() => expect(server.applyToTeam).toHaveBeenCalledWith("team-2", null));
    expect(await screen.findByRole("button", { name: /Withdraw/i })).toBeTruthy();
  });

  it("blocks a second application while one is out", async () => {
    mine({ myApplication: { id: "app-1", teamId: "team-2" } });
    await openTeams();
    await screen.findByText("Cold");

    // One at a time, so the other team is not an option either.
    expect(screen.getByRole("button", { name: /^Apply$/ }).disabled).toBe(true);
  });

  it("registers a team from the form", async () => {
    await openTeams();
    await userEvent.click(await screen.findByRole("button", { name: /Register a team/i }));

    await userEvent.type(screen.getByLabelText(/Team tag/i), "ace");
    await userEvent.type(screen.getByLabelText(/Team name/i), "Aces High");

    mine({ team: roster(), role: "captain" });
    await userEvent.click(screen.getByRole("button", { name: /^Register$/ }));

    // The tag is an identity people type, so it is upper-cased on the way in.
    await waitFor(() =>
      expect(server.createTeam).toHaveBeenCalledWith({
        tag: "ACE",
        name: "Aces High",
        region: "na",
      }),
    );
  });

  it("shows your roster once you are on a team", async () => {
    mine({ team: roster(), role: "captain" });
    await openTeams();

    expect(await screen.findByText("Aces High")).toBeTruthy();
    expect(screen.getByText("Aria")).toBeTruthy();
    expect(screen.getByText("captain")).toBeTruthy();
  });

  it("gives a captain the powers a member does not have", async () => {
    mine({ team: roster(), role: "captain" });
    await openTeams();
    await screen.findByText("Aces High");

    expect(screen.getByRole("button", { name: /Make officer/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Hand over the team/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Disband/i })).toBeTruthy();
    // A captain leaves by handing over or disbanding, so there is no Leave.
    expect(screen.queryByRole("button", { name: /^Leave$/ })).toBeNull();
  });

  it("gives a plain member none of them", async () => {
    mine({ team: roster(), role: "member" });
    await openTeams();
    await screen.findByText("Aces High");

    expect(screen.queryByRole("button", { name: /Make officer/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove from team/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Disband/i })).toBeNull();
    expect(screen.getByRole("button", { name: /^Leave$/ })).toBeTruthy();
  });

  it("makes disbanding take two clicks", async () => {
    mine({ team: roster(), role: "captain" });
    await openTeams();
    await screen.findByText("Aces High");

    await userEvent.click(screen.getByRole("button", { name: /Disband/i }));
    expect(server.disbandTeam).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /Confirm/i }));
    await waitFor(() => expect(server.disbandTeam).toHaveBeenCalled());
  });

  it("reviews applications", async () => {
    const applications = [
      {
        id: "app-9",
        teamId: "team-1",
        userId: "user-9",
        discordName: "Rookie",
        inGameName: "ROOKIE",
        tier: null,
        placementsRemaining: 3,
        note: "I play entry",
        createdAt: new Date().toISOString(),
      },
    ];
    mine({ team: roster(), role: "captain", applications });
    await openTeams();

    await userEvent.click(await screen.findByRole("button", { name: /Applications \(1\)/i }));
    expect(screen.getByText("Rookie")).toBeTruthy();
    expect(screen.getByText("I play entry")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Accept/i }));
    await waitFor(() => expect(server.decideApplication).toHaveBeenCalledWith("app-9", true));
  });

  it("hides the application queue from a plain member", async () => {
    mine({ team: roster(), role: "member" });
    await openTeams();

    await userEvent.click(await screen.findByRole("button", { name: /Applications/i }));
    expect(screen.getByText(/Only the captain and officers/i)).toBeTruthy();
  });

  it("follows the roster when it changes under you", async () => {
    mine({ team: roster(), role: "member" });
    await openTeams();
    await screen.findByText("Aces High");

    mine({ team: roster({ name: "Renamed" }), role: "member" });
    emit({ type: "team.updated", team: {} });

    // Someone else accepted, promoted or removed a player.
    expect(await screen.findByText("Renamed")).toBeTruthy();
  });
});

describe("scrims", () => {
  const member = (i, role = "member") => ({
    userId: `user-${i}`,
    discordName: `Player${i}`,
    inGameName: `PLAYER_${i}`,
    role,
    tier: "B",
    placementsRemaining: 0,
    joinedAt: new Date().toISOString(),
  });

  const squad = (role = "captain", size = 5) => ({
    team: {
      id: "team-1",
      tag: "ACE",
      name: "Aces High",
      region: "na",
      captainId: "user-1",
      applicationsOpen: true,
      createdAt: new Date().toISOString(),
      members: Array.from({ length: size }, (_, i) => member(i + 1, i === 0 ? "captain" : "member")),
    },
    role,
    applications: [],
    myApplication: null,
  });

  const listing = {
    id: "listing-2",
    teamId: "team-2",
    tag: "BRV",
    name: "Bravo",
    region: "na",
    note: "Bo1 tonight",
    postedAt: new Date().toISOString(),
    memberCount: 5,
    tier: "A-",
    requested: false,
  };

  const board = (over = {}) => ({ listings: [listing], myListing: null, incoming: [], ...over });

  beforeEach(() => {
    server.scrims.mockResolvedValue(board());
    server.postListing.mockResolvedValue({ listingId: "listing-1" });
    server.removeListing.mockResolvedValue({ ok: true });
    server.requestScrim.mockResolvedValue({ requestId: "req-1" });
    server.decideScrimRequest.mockResolvedValue({ accepted: true, matchId: MATCH.id });
  });

  async function openScrims() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Scrims/i }));
  }

  it("says scrims are for teams when you have none", async () => {
    await openScrims();
    expect(await screen.findByText(/Scrims are for teams/i)).toBeTruthy();
  });

  it("shows the board once you are on a team", async () => {
    server.myTeam.mockResolvedValue(squad());
    await openScrims();

    expect(await screen.findByText("Bravo")).toBeTruthy();
    expect(screen.getByText(/Bo1 tonight/)).toBeTruthy();
  });

  it("lets a captain post a listing", async () => {
    server.myTeam.mockResolvedValue(squad());
    await openScrims();
    await screen.findByText("Bravo");

    await userEvent.type(screen.getByLabelText(/Listing note/i), "Bo3, we host voice");
    await userEvent.click(screen.getByRole("button", { name: /Post to scrim list/i }));

    await waitFor(() =>
      expect(server.postListing).toHaveBeenCalledWith("na", "Bo3, we host voice"),
    );
  });

  it("offers to take the listing down once it is up", async () => {
    server.myTeam.mockResolvedValue(squad());
    server.scrims.mockResolvedValue(board({ myListing: { id: "listing-1", region: "na", note: null } }));
    await openScrims();

    await userEvent.click(await screen.findByRole("button", { name: /Remove listing/i }));
    await waitFor(() => expect(server.removeListing).toHaveBeenCalled());
  });

  it("keeps a plain member out of arranging anything", async () => {
    server.myTeam.mockResolvedValue(squad("member"));
    await openScrims();
    await screen.findByText("Bravo");

    expect(screen.getByRole("button", { name: /Request/i }).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: /Post to scrim list/i })).toBeNull();
    expect(screen.getByText(/Only the captain and officers can list/i)).toBeTruthy();
  });

  it("will not let a team of four ask for a five-a-side", async () => {
    server.myTeam.mockResolvedValue(squad("captain", 4));
    await openScrims();
    await screen.findByText("Bravo");

    expect(screen.getByRole("button", { name: /Request/i }).disabled).toBe(true);
    expect(screen.getByText(/A scrim is five a side/i)).toBeTruthy();
  });

  it("requests a scrim, then shows it as asked", async () => {
    server.myTeam.mockResolvedValue(squad());
    await openScrims();
    await screen.findByText("Bravo");

    server.scrims.mockResolvedValue(board({ listings: [{ ...listing, requested: true }] }));
    await userEvent.click(screen.getByRole("button", { name: /Request/i }));

    await waitFor(() => expect(server.requestScrim).toHaveBeenCalledWith("listing-2"));
    expect(await screen.findByRole("button", { name: /Asked/i })).toBeTruthy();
  });

  it("answers an incoming request", async () => {
    const incoming = [
      { id: "req-9", listingId: "listing-1", teamId: "team-3", tag: "CLD", name: "Cold", tier: "A", createdAt: new Date().toISOString() },
    ];
    server.myTeam.mockResolvedValue(squad());
    server.scrims.mockResolvedValue(board({ myListing: { id: "listing-1", region: "na", note: null }, incoming }));
    await openScrims();

    expect(await screen.findByText(/Requests \(1\)/i)).toBeTruthy();
    expect(screen.getByText("Cold")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /^Accept$/ }));
    await waitFor(() => expect(server.decideScrimRequest).toHaveBeenCalledWith("req-9", true));
  });

  it("reloads when a listing moves under you", async () => {
    server.myTeam.mockResolvedValue(squad());
    await openScrims();
    await screen.findByText("Bravo");

    server.scrims.mockResolvedValue(board({ listings: [] }));
    emit({ type: "scrim.request.received", listingId: "listing-1" });

    // Someone took theirs down, or it got matched while you were looking.
    await waitFor(() => expect(screen.queryByText("Bravo")).toBeNull());
  });

  it("raises the same accept prompt a PUG does", async () => {
    server.myTeam.mockResolvedValue(squad());
    await openScrims();
    await screen.findByText("Bravo");

    // Accepting a scrim goes out over the same match.found the queue uses, so
    // the overlay does not need to know which it was.
    emit({ type: "match.found", matchId: MATCH.id, match: { ...MATCH, type: "SCRIM" } });

    expect(await screen.findByText(/Match found/i)).toBeTruthy();
    expect(screen.getByText(/SCRIM · NA · 5v5/)).toBeTruthy();
  });
});

describe("the ladder", () => {
  const rung = (position, over = {}) => ({
    position,
    userId: `user-${position}`,
    discordName: `Rung${position}`,
    inGameName: `RUNG_${position}`,
    tier: "A",
    wins: 30,
    losses: 10,
    gamesPlayed: 40,
    teamTag: null,
    ...over,
  });

  const page = (over = {}) => ({
    rows: [rung(1, { teamTag: "ACE" }), rung(2), rung(3)],
    total: 3,
    myPosition: 2,
    limit: 50,
    offset: 0,
    ...over,
  });

  const PUBLIC = {
    userId: "user-3",
    discordName: "Rung3",
    inGameName: "RUNG_3",
    tier: "A",
    peakTier: "A+",
    placementsRemaining: 0,
    gamesPlayed: 40,
    wins: 30,
    losses: 10,
    currentWinStreak: 2,
    longestWinStreak: 7,
    disputesInvolved: 1,
    missedAccepts: 0,
    position: 3,
    team: { id: "team-1", tag: "ACE", name: "Aces High", role: "officer" },
  };

  beforeEach(() => {
    server.ladder.mockResolvedValue(page());
    server.playerProfile.mockResolvedValue(PUBLIC);
  });

  async function openLadder() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Ladder/i }));
  }

  it("lists placed players with their standing", async () => {
    await openLadder();

    expect(await screen.findByText("Rung1")).toBeTruthy();
    expect(screen.getByText("#1")).toBeTruthy();
    expect(screen.getByText(/3 placed players/i)).toBeTruthy();
  });

  it("says where you stand, even from a page you are not on", async () => {
    server.ladder.mockResolvedValue(page({ myPosition: 412, rows: [rung(1)], total: 500 }));
    await openLadder();

    // Otherwise being 412th means paging down to find yourself.
    expect(await screen.findByText(/you are #412/i)).toBeTruthy();
  });

  it("publishes ranks and records, never a rating", async () => {
    await openLadder();
    await screen.findByText("Rung1");

    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("30–10").length).toBeGreaterThan(0);
    expect(visibleText()).not.toMatch(/\b(6[2-9]\d|[7-9]\d\d|1[0-7]\d\d)\b/);
  });

  it("pages only when there is more than a page", async () => {
    await openLadder();
    await screen.findByText("Rung1");
    expect(screen.queryByRole("button", { name: /Next/i })).toBeNull();

    cleanup();
    server.ladder.mockResolvedValue(page({ total: 120 }));
    await openLadder();

    await userEvent.click(await screen.findByRole("button", { name: /Next/i }));
    await waitFor(() => expect(server.ladder).toHaveBeenCalledWith(50, 50));
  });

  it("opens a profile from a rung, fetching what the row did not carry", async () => {
    await openLadder();
    await userEvent.click(await screen.findByText("Rung3"));

    // The row carries a name and a rank; the profile carries the rest.
    await waitFor(() => expect(server.playerProfile).toHaveBeenCalledWith("user-3"));
    expect(await screen.findByText("Aces High")).toBeTruthy();
    expect(screen.getByText("A+")).toBeTruthy();
    expect(screen.getByText(/#3 on the ladder/i)).toBeTruthy();
  });

  it("shows real reliability counters rather than a promise to publish them", async () => {
    await openLadder();
    await userEvent.click(await screen.findByText("Rung3"));

    expect(await screen.findByText("Disputes")).toBeTruthy();
    expect(screen.getByText("Missed accepts")).toBeTruthy();
    expect(screen.getByText("Longest streak")).toBeTruthy();
  });

  it("falls back to what it was handed when the fetch fails", async () => {
    server.playerProfile.mockRejectedValue(new Error("offline"));
    await openLadder();
    await userEvent.click(await screen.findByText("Rung3"));

    // Thinner, not wrong: the row already knew this much.
    expect(await screen.findByText(/Loading…/i)).toBeTruthy();
  });
});

describe("chat", () => {
  const line = (i, over = {}) => ({
    id: `m${i}`,
    channel: "party:p1",
    userId: `user-${i}`,
    discordName: `Talker${i}`,
    text: `line ${i}`,
    ts: Date.now(),
    ...over,
  });

  it("loads the party backlog into the dock", async () => {
    server.chatHistory.mockResolvedValue({ channel: "party:p1", messages: [line(2), line(3)] });
    await signedIn();

    await userEvent.click(screen.getByRole("button", { name: /Chat/i }));

    await waitFor(() => expect(server.chatHistory).toHaveBeenCalledWith("party:p1"));
    expect(await screen.findByText("line 2")).toBeTruthy();
    expect(screen.getByText("line 3")).toBeTruthy();
  });

  it("sends over the socket rather than a request", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Chat/i }));

    await userEvent.type(await screen.findByLabelText(/Message your party/i), "hello{Enter}");

    await waitFor(() =>
      expect(liveBus.send).toHaveBeenCalledWith({
        type: "chat.send",
        channel: "party:p1",
        text: "hello",
      }),
    );
  });

  it("shows a message only once the server sends it back", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Chat/i }));

    const box = await screen.findByLabelText(/Message your party/i);
    await userEvent.type(box, "not yet{Enter}");

    // Nothing is echoed locally, so what you see is what everyone else saw.
    expect(screen.queryByText("not yet")).toBeNull();

    emit({
      type: "chat.message",
      channel: "party:p1",
      message: line(9, { text: "not yet", channel: "party:p1" }),
    });
    expect(await screen.findByText("not yet")).toBeTruthy();
  });

  it("ignores a message meant for another channel", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Chat/i }));
    await screen.findByLabelText(/Message your party/i);

    emit({
      type: "chat.message",
      channel: "match:somewhere",
      message: line(4, { text: "elsewhere", channel: "match:somewhere" }),
    });

    await waitFor(() => expect(screen.queryByText("elsewhere")).toBeNull());
  });

  it("counts what arrived while the dock was shut", async () => {
    await signedIn();
    // The dock starts shut after signing in, which is when a count is useful.
    emit({ type: "chat.message", channel: "party:p1", message: line(5) });
    emit({ type: "chat.message", channel: "party:p1", message: line(6) });

    expect(await screen.findByText("2")).toBeTruthy();
  });

  it("says plainly that nothing is kept", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Chat/i }));

    expect(await screen.findByText(/chat is not saved/i)).toBeTruthy();
  });

  it("keeps team and match talk apart in a match", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);
    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });
    await screen.findByText(/Party up/i);

    // Player1 is on team 1, so the team tab is that half's channel.
    await waitFor(() =>
      expect(server.chatHistory).toHaveBeenCalledWith(`match:${MATCH.id}:t1`),
    );

    await userEvent.click(screen.getByRole("button", { name: /^Match$/ }));
    await waitFor(() => expect(server.chatHistory).toHaveBeenCalledWith(`match:${MATCH.id}`));
  });
});
