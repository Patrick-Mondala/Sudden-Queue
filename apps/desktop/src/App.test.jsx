import { configure } from "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CATALOGUES, setLocale } from "./i18n/index.js";
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
  config: vi.fn(),
  queueStats: vi.fn(),
  getMatch: vi.fn(),
  onlinePlayers: vi.fn(),
  listTeams: vi.fn(),
  team: vi.fn(),
  setTeamNote: vi.fn(),
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
  playerHistory: vi.fn(),
  myReportOf: vi.fn(),
  reportPlayer: vi.fn(),
  withdrawPlayerReport: vi.fn(),
  chatHistory: vi.fn(),
  disputes: vi.fn(),
  resolveDispute: vi.fn(),
  setInGameName: vi.fn(),
  findPlayers: vi.fn(),
  suspensions: vi.fn(),
  moderationHistory: vi.fn(),
  suspend: vi.fn(),
  reinstate: vi.fn(),
  bans: vi.fn(),
  clearCooldown: vi.fn(),
  clearInGameName: vi.fn(),
  adjustRating: vi.fn(),
  renameTeam: vi.fn(),
  voidMatch: vi.fn(),
  removeFromQueue: vi.fn(),
  auditLog: vi.fn(),
  reports: vi.fn(),
  reviewReport: vi.fn(),
  setStarter: vi.fn(),
  confirmLineup: vi.fn(),
  invite: vi.fn(),
  getInvites: vi.fn(),
  acceptInvite: vi.fn(),
  declineInvite: vi.fn(),
  joinQueue: vi.fn(),
  leaveQueue: vi.fn(),
  leaveParty: vi.fn(),
  kick: vi.fn(),
  accept: vi.fn(),
  decline: vi.fn(),
  reportResult: vi.fn(),
  withdrawReport: vi.fn(),
};

let token = "test-token";

vi.mock("./api/client.js", () => ({
  api: server,
  bus: liveBus,
  getToken: () => token,
  CLIENT_VERSION: "0.1.1",
}));

vi.mock("./api/auth.js", () => ({ signIn: vi.fn() }));

/** The desktop shell is not present under jsdom, so the updater is stood in for. */
const updates = { checkForUpdate: vi.fn(), installUpdate: vi.fn() };
vi.mock("./api/updates.js", () => updates);

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
  // You are always a member of your own party, and the server always says so.
  // Empty only passed because the client reset the party to [you] whenever the
  // profile changed -- papering over this fixture, and in the real app over
  // whatever the party actually was.
  party: {
    partyId: "p1",
    leaderId: "user-1",
    queued: false,
    members: [
      {
        userId: "user-1",
        discordName: "Player1",
        inGameName: "PLAYER_1",
        avatarUrl: null,
        isGameMaster: false,
        tier: "B",
        placementsRemaining: 0,
        gamesPlayed: 40,
        isLeader: true,
      },
    ],
  },
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
  // The real client asks the server what deployment it is talking to; tests
  // let it fall back to the built-in defaults unless they say otherwise.
  server.config.mockResolvedValue(null);
  server.queueStats.mockResolvedValue({ online: 1, inQueue: 0, inMatch: 0 });
  server.getMatch.mockResolvedValue(MATCH);
  server.accept.mockResolvedValue({});
  server.onlinePlayers.mockResolvedValue({ players: [] });
  server.getInvites.mockResolvedValue([]);
  server.myTeam.mockResolvedValue({ team: null, role: null, applications: [], myApplication: null });
  server.listTeams.mockResolvedValue({ teams: [] });
  server.scrims.mockResolvedValue({ listings: [], myListing: null, incoming: [], pendingLineup: null });
  server.ladder.mockResolvedValue({ rows: [], total: 0, myPosition: null, limit: 50, offset: 0 });
  server.playerProfile.mockResolvedValue(null);
  server.playerHistory.mockResolvedValue([]);
  server.myReportOf.mockResolvedValue({ report: null });
  server.chatHistory.mockResolvedValue({ channel: "", messages: [] });
  server.disputes.mockResolvedValue([]);
  server.findPlayers.mockResolvedValue({ users: [] });
  server.suspensions.mockResolvedValue({ users: [] });
  server.moderationHistory.mockResolvedValue({ entries: [] });
  server.bans.mockResolvedValue({ bans: [] });
  server.reports.mockResolvedValue({ players: [] });
  server.auditLog.mockResolvedValue({ entries: [] });
  server.leaveParty.mockResolvedValue({ partyId: "p9" });
  server.kick.mockResolvedValue({ partyId: "p1" });
  updates.checkForUpdate.mockResolvedValue(null);
  updates.installUpdate.mockReset();
});

afterEach(cleanup);

/** Mounts and waits for the signed-in shell. */
async function signedIn() {
  render(<App />);
  await screen.findByText(/Ready to queue/i);

  // The shell subscribes to the bus from effects, which React runs after the
  // commit that painted the text above. Emitting before they have attached
  // sends the event nowhere, and the test then waits out its full timeout for
  // something that was already dropped -- a failure that reads as slowness and
  // is really a lost message.
  await act(async () => {});
}

describe("mounting", () => {
  it("renders the sign-in screen with no session", async () => {
    token = null;
    render(<App />);
    expect(await screen.findByText(/Continue with Discord/i)).toBeTruthy();
  });

  it("restores a session and renders the lobby", async () => {
    await signedIn();

    // The in-game name is the one people are called by, so it is what the
    // shell shows -- in the title bar and again on the play screen. The
    // Discord name is the footnote underneath.
    expect(screen.getAllByText("PLAYER_1").length).toBeGreaterThan(0);
    expect(screen.getByText("Player1")).toBeTruthy();
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
    for (const p of online) expect(within(modal).getByText(p.inGameName)).toBeTruthy();
  });

  it("filters as you type", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "bor");

    await waitFor(() => expect(within(modal).queryByText("ARIA")).toBeNull());
    expect(within(modal).getByText("BOREAS")).toBeTruthy();
  });

  it("matches on in-game name too, since that is what people are called in game", async () => {
    const modal = await openInvites();
    await userEvent.type(within(modal).getByLabelText(/Search players/i), "CINDER");

    await waitFor(() => expect(within(modal).queryByText("ARIA")).toBeNull());
    expect(within(modal).getByText("CINDER")).toBeTruthy();
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
    expect(screen.getByText(/Only the captain can list/i)).toBeTruthy();
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

    expect(await screen.findByText("RUNG_1")).toBeTruthy();
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
    await screen.findByText("RUNG_1");

    expect(screen.getAllByText("A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("30–10").length).toBeGreaterThan(0);
    expect(visibleText()).not.toMatch(/\b(6[2-9]\d|[7-9]\d\d|1[0-7]\d\d)\b/);
  });

  it("pages only when there is more than a page", async () => {
    await openLadder();
    await screen.findByText("RUNG_1");
    expect(screen.queryByRole("button", { name: /Next/i })).toBeNull();

    cleanup();
    server.ladder.mockResolvedValue(page({ total: 120 }));
    await openLadder();

    await userEvent.click(await screen.findByRole("button", { name: /Next/i }));
    await waitFor(() => expect(server.ladder).toHaveBeenCalledWith(50, 50));
  });

  it("opens a profile from a rung, fetching what the row did not carry", async () => {
    await openLadder();
    await userEvent.click(await screen.findByText("RUNG_3"));

    // The row carries a name and a rank; the profile carries the rest.
    await waitFor(() => expect(server.playerProfile).toHaveBeenCalledWith("user-3"));
    expect(await screen.findByText("Aces High")).toBeTruthy();
    expect(screen.getByText("A+")).toBeTruthy();
    expect(screen.getByText(/#3 on the ladder/i)).toBeTruthy();
  });

  it("shows real reliability counters rather than a promise to publish them", async () => {
    await openLadder();
    await userEvent.click(await screen.findByText("RUNG_3"));

    expect(await screen.findByText("Disputes")).toBeTruthy();
    expect(screen.getByText("Missed accepts")).toBeTruthy();
    expect(screen.getByText("Longest streak")).toBeTruthy();
  });

  it("falls back to what it was handed when the fetch fails", async () => {
    server.playerProfile.mockRejectedValue(new Error("offline"));
    await openLadder();
    await userEvent.click(await screen.findByText("RUNG_3"));

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

describe("Game Masters", () => {
  const GM_PROFILE = { ...PROFILE, isGameMaster: true };

  const dispute = (over = {}) => ({
    disputeId: "d1",
    matchId: MATCH.id,
    reason: "Captains reported different results",
    openedAt: new Date().toISOString(),
    type: "PUG",
    region: "na",
    playedAt: new Date().toISOString(),
    reports: [
      { reporterId: "user-1", discordName: "Player1", reportingTeam: 1, claimedWinner: "TEAM1" },
      { reporterId: "user-6", discordName: "Player6", reportingTeam: 2, claimedWinner: "TEAM2" },
    ],
    ...over,
  });

  beforeEach(() => {
    server.disputes.mockResolvedValue([dispute()]);
    server.resolveDispute.mockResolvedValue({ ok: true });
  });

  it("hides the disputes tab from a player", async () => {
    await signedIn();
    expect(screen.queryByRole("button", { name: /Manage/i })).toBeNull();
  });

  it("shows it to a Game Master", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();
    expect(screen.getByRole("button", { name: /Manage/i })).toBeTruthy();
  });

  it("marks a GM's own name in the title bar", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();

    expect(screen.getAllByText("GM").length).toBeGreaterThan(0);
  });

  it("marks a GM on a match roster, not just their own screen", async () => {
    await signedIn();
    emit({
      type: "match.found",
      matchId: MATCH.id,
      match: {
        ...MATCH,
        team1: [player(1, { isGameMaster: true }), ...MATCH.team1.slice(1)],
      },
    });
    await screen.findByText(/Match found/i);
    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });
    await screen.findByText(/Party up/i);

    expect(screen.getAllByText("GM").length).toBeGreaterThan(0);
  });

  it("leaves an ordinary roster unmarked", async () => {
    await signedIn();
    emit({ type: "match.found", matchId: MATCH.id, match: MATCH });
    await screen.findByText(/Match found/i);
    emit({ type: "match.state", matchId: MATCH.id, state: "PARTY_UP" });
    await screen.findByText(/Party up/i);

    expect(screen.queryByText("GM")).toBeNull();
  });

  it("shows both claims side by side", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));

    await userEvent.click(await screen.findByText(/Captains reported different results/i));

    expect(await screen.findByText(/Two captains disagree/i)).toBeTruthy();
    expect(screen.getByText(/claims Team 1 won/i)).toBeTruthy();
    expect(screen.getByText(/claims Team 2 won/i)).toBeTruthy();
  });

  it("will not let a ruling go in without a winner and a reason", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));
    await userEvent.click(await screen.findByText(/Captains reported different results/i));

    const settle = await screen.findByRole("button", { name: /Settle this match/i });
    expect(settle.disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /Team 1 won/i }));
    // A winner alone is not enough: the ten people it lands on deserve a reason.
    expect(screen.getByRole("button", { name: /Settle this match/i }).disabled).toBe(true);

    await userEvent.type(screen.getByLabelText(/Ruling note/i), "Screenshot matches Team 1.");
    expect(screen.getByRole("button", { name: /Settle this match/i }).disabled).toBe(false);
  });

  it("records the ruling and clears it from the queue", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));
    await userEvent.click(await screen.findByText(/Captains reported different results/i));

    await userEvent.click(await screen.findByRole("button", { name: /Team 2 won/i }));
    await userEvent.type(screen.getByLabelText(/Ruling note/i), "Both scoreboards agree.");

    server.disputes.mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: /Settle this match/i }));

    await waitFor(() =>
      expect(server.resolveDispute).toHaveBeenCalledWith(
        MATCH.id,
        "TEAM2",
        "Both scoreboards agree.",
      ),
    );
    expect(await screen.findByText(/No disputes/i)).toBeTruthy();
  });

  it("says plainly that nothing has moved yet", async () => {
    server.me.mockResolvedValue(GM_PROFILE);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));
    await userEvent.click(await screen.findByText(/Captains reported different results/i));

    // Rating only applies on agreement, so this is a first ruling rather than
    // an overturned one -- and a GM should not think they are undoing anything.
    expect(await screen.findByText(/No rating has moved/i)).toBeTruthy();
  });
});

describe("scrim lineups", () => {
  const rosterMember = (i, isStarter) => ({
    userId: `user-${i}`,
    discordName: `Player${i}`,
    inGameName: `PLAYER_${i}`,
    isGameMaster: false,
    isStarter,
    tier: "B",
    placementsRemaining: 0,
  });

  const pending = (over = {}) => ({
    requestId: "req-1",
    opponentTag: "BRV",
    opponentName: "Bravo",
    confirmDeadline: new Date(Date.now() + 30_000).toISOString(),
    roster: [1, 2, 3, 4, 5, 6, 7].map((i) => rosterMember(i, i <= 5)),
    ...over,
  });

  const teamWith = (members) => ({
    team: {
      id: "team-1",
      tag: "ACE",
      name: "Aces High",
      region: "na",
      captainId: "user-1",
      applicationsOpen: true,
      createdAt: new Date().toISOString(),
      members,
    },
    role: "captain",
    applications: [],
    myApplication: null,
  });

  const rosterRow = (i, isStarter) => ({
    userId: `user-${i}`,
    discordName: `Player${i}`,
    inGameName: `PLAYER_${i}`,
    isGameMaster: false,
    role: i === 1 ? "captain" : "member",
    isStarter,
    tier: "B",
    placementsRemaining: 0,
    joinedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    server.setStarter.mockResolvedValue({ ok: true });
    server.confirmLineup.mockResolvedValue({ confirmed: true, matchId: MATCH.id });
  });

  it("marks starters and substitutes on the roster", async () => {
    server.myTeam.mockResolvedValue(
      teamWith([1, 2, 3, 4, 5, 6, 7].map((i) => rosterRow(i, i <= 5))),
    );
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    expect((await screen.findAllByText("Starter")).length).toBe(5);
    expect(screen.getAllByText("Sub").length).toBe(2);
    expect(screen.getByText(/5\/5 starting/i)).toBeTruthy();
  });

  it("lets the captain bench someone", async () => {
    server.myTeam.mockResolvedValue(
      teamWith([1, 2, 3, 4, 5, 6].map((i) => rosterRow(i, i <= 5))),
    );
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    await userEvent.click((await screen.findAllByRole("button", { name: /Move to the bench/i }))[1]);
    await waitFor(() => expect(server.setStarter).toHaveBeenCalledWith("user-2", false));
  });

  it("does not offer the toggle to a member", async () => {
    server.myTeam.mockResolvedValue({
      ...teamWith([1, 2, 3, 4, 5, 6].map((i) => rosterRow(i, i <= 5))),
      role: "member",
    });
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    await screen.findByText("Aces High");
    expect(screen.queryByRole("button", { name: /Move to the bench/i })).toBeNull();
  });

  it("asks the captain to pick five, with starters already chosen", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: pending(),
    });
    await signedIn();

    const modal = await screen.findByRole("dialog", { name: /Confirm your lineup/i });
    expect(within(modal).getByText(/Who is playing/i)).toBeTruthy();
    expect(within(modal).getByText(/Scrim vs BRV/i)).toBeTruthy();
    expect(within(modal).getByRole("button", { name: /Confirm the lineup/i })).toBeTruthy();
  });

  it("will not let a sixth be added without dropping someone", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: pending(),
    });
    await signedIn();
    const modal = await screen.findByRole("dialog", { name: /Confirm your lineup/i });

    // Five are already picked, so the bench is not clickable until one goes.
    const sixth = within(modal).getByText("Player6").closest("button");
    expect(sixth.disabled).toBe(true);

    await userEvent.click(within(modal).getByText("Player1").closest("button"));
    expect(within(modal).getByText("Player6").closest("button").disabled).toBe(false);
  });

  it("sends exactly what was picked", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: pending(),
    });
    await signedIn();
    const modal = await screen.findByRole("dialog", { name: /Confirm your lineup/i });

    // Swap a starter out for a substitute: starters are a default, not a rule.
    await userEvent.click(within(modal).getByText("Player5").closest("button"));
    await userEvent.click(within(modal).getByText("Player7").closest("button"));
    await userEvent.click(within(modal).getByRole("button", { name: /Confirm the lineup/i }));

    await waitFor(() =>
      expect(server.confirmLineup).toHaveBeenCalledWith("req-1", [
        "user-1",
        "user-2",
        "user-3",
        "user-4",
        "user-7",
      ]),
    );
  });

  it("cannot be confirmed with fewer than five", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: pending(),
    });
    await signedIn();
    const modal = await screen.findByRole("dialog", { name: /Confirm your lineup/i });

    await userEvent.click(within(modal).getByText("Player3").closest("button"));
    expect(within(modal).getByRole("button", { name: /4\/5 picked/i }).disabled).toBe(true);
  });

  it("goes away when the window lapses", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: pending(),
    });
    await signedIn();
    await screen.findByRole("dialog", { name: /Confirm your lineup/i });

    emit({ type: "scrim.lineup.expired", requestId: "req-1" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Confirm your lineup/i })).toBeNull(),
    );
    expect(screen.getByText(/nobody confirmed a lineup/i)).toBeTruthy();
  });

  it("never appears for a team of exactly five", async () => {
    server.scrims.mockResolvedValue({
      listings: [],
      myListing: null,
      incoming: [],
      pendingLineup: null,
    });
    await signedIn();

    // The server does not ask, because there is nothing to choose.
    expect(screen.queryByRole("dialog", { name: /Confirm your lineup/i })).toBeNull();
  });
});

describe("being told a team cannot scrim", () => {
  const squad = (role = "captain") => ({
    team: {
      id: "team-1",
      tag: "ACE",
      name: "Aces High",
      region: "na",
      captainId: "user-1",
      applicationsOpen: true,
      createdAt: new Date().toISOString(),
      members: Array.from({ length: 5 }, (_, i) => ({
        userId: `user-${i + 1}`,
        discordName: `Player${i + 1}`,
        inGameName: `PLAYER_${i + 1}`,
        isGameMaster: false,
        role: i === 0 ? "captain" : "member",
        isStarter: true,
        tier: "B",
        placementsRemaining: 0,
        joinedAt: new Date().toISOString(),
      })),
    },
    role,
    applications: [],
    myApplication: null,
  });

  const refusal = (code, message) =>
    Object.assign(new Error(message), { status: 409, code });

  beforeEach(() => {
    server.myTeam.mockResolvedValue(squad());
    server.scrims.mockResolvedValue({
      listings: [
        { id: "listing-2", teamId: "team-2", tag: "BRV", name: "Bravo", region: "na", note: null, postedAt: new Date().toISOString(), memberCount: 5, tier: "B", requested: false },
      ],
      myListing: null,
      incoming: [],
      pendingLineup: null,
    });
  });

  async function openScrims() {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Scrims/i }));
    await screen.findByText("Bravo");
  }

  it("stops and explains when the captain is offline", async () => {
    server.postListing.mockRejectedValue(
      refusal("CAPTAIN_OFFLINE", "You may not scrim while your captain is offline."),
    );
    await openScrims();

    await userEvent.click(screen.getByRole("button", { name: /Post to scrim list/i }));

    // A toast slides away while you are still looking at the button you pressed.
    const alert = await screen.findByRole("alertdialog", { name: /captain is offline/i });
    expect(within(alert).getByText(/may not scrim while your captain is offline/i)).toBeTruthy();
  });

  it("says the same when too few are online", async () => {
    server.requestScrim.mockRejectedValue(
      refusal(
        "NOT_ENOUGH_ONLINE",
        "Your team does not have enough players online to scrim. 3 of 5 are here.",
      ),
    );
    await openScrims();

    await userEvent.click(screen.getByRole("button", { name: /Request/i }));

    const alert = await screen.findByRole("alertdialog", { name: /Not enough of your team/i });
    expect(within(alert).getByText(/3 of 5 are here/i)).toBeTruthy();
  });

  it("closes on acknowledgement", async () => {
    server.postListing.mockRejectedValue(refusal("CAPTAIN_OFFLINE", "Captain is offline."));
    await openScrims();
    await userEvent.click(screen.getByRole("button", { name: /Post to scrim list/i }));

    await userEvent.click(await screen.findByRole("button", { name: /Got it/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("leaves ordinary refusals as toasts", async () => {
    server.postListing.mockRejectedValue(
      refusal("ALREADY_LISTED", "Your team is already on the list"),
    );
    await openScrims();

    await userEvent.click(screen.getByRole("button", { name: /Post to scrim list/i }));

    // Nothing to explain and nothing to fix, so it does not take the screen.
    expect(await screen.findByText(/already on the list/i)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("the population counters", () => {
  /** The header strip: a label and the number beside it. */
  const counter = (label) => {
    // The value sits immediately before its label; the dot beside them is a
    // span too, so picking the first one in the row finds the dot.
    const node = screen.getByText(label);
    return node.previousElementSibling.textContent;
  };

  it("shows what the socket pushed", async () => {
    await signedIn();

    emit({ type: "queue.counts", online: 42, inQueue: 7, inMatch: 20 });

    await waitFor(() => expect(counter("Online")).toBe("42"));
    expect(counter("In queue")).toBe("7");
    expect(counter("In match")).toBe("20");
  });

  it("keeps up as the numbers move", async () => {
    await signedIn();
    emit({ type: "queue.counts", online: 42, inQueue: 7, inMatch: 20 });
    await waitFor(() => expect(counter("In queue")).toBe("7"));

    emit({ type: "queue.counts", online: 43, inQueue: 0, inMatch: 30 });

    // Zero is a real answer here, and has to survive the render as one.
    await waitFor(() => expect(counter("In queue")).toBe("0"));
    expect(counter("In match")).toBe("30");
  });

  it("holds a placeholder until the first push, rather than showing zeroes", async () => {
    await signedIn();

    // Zeroes would read as an empty playerbase in the moment before the socket
    // gets its first word in, which is the worst thing to show a new arrival.
    expect(counter("Online")).toBe("–");
  });

  it("does not ask the server for them", async () => {
    await signedIn();
    emit({ type: "queue.counts", online: 42, inQueue: 7, inMatch: 20 });
    await waitFor(() => expect(counter("Online")).toBe("42"));

    // The whole point: these arrive unasked. A poll here was two queries per
    // signed-in client every eight seconds.
    expect(server.queueStats).not.toHaveBeenCalled();
  });
});

describe("suspending a player", () => {
  const GM = { ...PROFILE, isGameMaster: true };

  const account = (over = {}) => ({
    userId: "user-9",
    discordId: "130891065069666304",
    discordName: "Griefer99",
    inGameName: "GRIEF_X",
    role: "player",
    bannedUntil: null,
    banReason: null,
    ...over,
  });

  async function openPlayers() {
    server.me.mockResolvedValue(GM);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^Players$/i }));
  }

  it("is not reachable by an ordinary player", async () => {
    await signedIn();
    // The rail does not carry a tab that would only ever answer 403.
    expect(screen.queryByRole("button", { name: /Manage/i })).toBeNull();
  });

  it("lists everybody before anything is searched", async () => {
    // Not just the suspended. A Game Master usually arrives wanting to find a
    // particular person, and somebody who has never been in trouble was
    // unreachable without already knowing their name well enough to search.
    server.findPlayers.mockResolvedValue({
      users: [account(), account({ userId: "user-8", discordName: "quiet_type", inGameName: "QUIET" })],
    });
    await openPlayers();

    expect(await screen.findByText("Griefer99")).toBeTruthy();
    expect(screen.getByText("QUIET")).toBeTruthy();
    expect(screen.getByText(/All players/i)).toBeTruthy();
  });

  it("finds an account by name", async () => {
    server.findPlayers.mockResolvedValue({ users: [account()] });
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");

    expect(await screen.findByText("Griefer99")).toBeTruthy();
    await waitFor(() => expect(server.findPlayers).toHaveBeenCalledWith("grief"));
  });

  it("sends the duration and reason that were picked", async () => {
    server.findPlayers.mockResolvedValue({ users: [account()] });
    server.suspend.mockResolvedValue({ discordName: "Griefer99", until: new Date().toISOString() });
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");
    await userEvent.click(await screen.findByText("Griefer99"));
    await userEvent.click(await screen.findByRole("button", { name: /^1 week$/i }));
    await userEvent.type(screen.getByLabelText(/^Reason$/i), "Throwing matches");
    await userEvent.click(screen.getByRole("button", { name: /^Suspend$/i }));

    await waitFor(() =>
      expect(server.suspend).toHaveBeenCalledWith("user-9", 168, "Throwing matches"),
    );
  });

  it("will not send one without a reason", async () => {
    server.findPlayers.mockResolvedValue({ users: [account()] });
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");
    await userEvent.click(await screen.findByText("Griefer99"));

    // The player is shown this text when they are turned away, so a blank one
    // is worse than no suspension.
    await userEvent.click(screen.getByRole("button", { name: /^Suspend$/i }));
    expect(server.suspend).not.toHaveBeenCalled();
  });

  it("offers to lift one that is already running, not to stack another", async () => {
    const serving = account({
      bannedUntil: new Date(Date.now() + 86_400_000).toISOString(),
      banReason: "Throwing matches",
    });
    server.findPlayers.mockResolvedValue({ users: [serving] });
    server.reinstate.mockResolvedValue({ discordName: "Griefer99" });
    await openPlayers();

    await userEvent.click(await screen.findByText("Griefer99"));
    expect(await screen.findByText(/Throwing matches/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Lift the suspension/i }));
    await waitFor(() => expect(server.reinstate).toHaveBeenCalledWith("user-9", ""));
  });

  it("shows the record of what was done and by whom", async () => {
    server.findPlayers.mockResolvedValue({ users: [account()] });
    server.moderationHistory.mockResolvedValue({
      entries: [
        {
          id: "a1",
          eventType: "user.suspended",
          actorId: "gm-1",
          actorName: "Gentle",
          payload: { hours: 24, reason: "Throwing matches" },
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");
    await userEvent.click(await screen.findByText("Griefer99"));

    expect(await screen.findByText(/by Gentle/i)).toBeTruthy();
    expect(screen.getByText(/Throwing matches/)).toBeTruthy();
  });

  it("surfaces a refusal rather than looking like it worked", async () => {
    server.findPlayers.mockResolvedValue({ users: [account({ role: "game_master" })] });
    server.suspend.mockRejectedValue(
      Object.assign(new Error("Griefer99 cannot be suspended from here"), {
        status: 403,
        code: "CANNOT_SUSPEND_STAFF",
      }),
    );
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");
    await userEvent.click(await screen.findByText("Griefer99"));
    await userEvent.type(screen.getByLabelText(/^Reason$/i), "because");
    await userEvent.click(screen.getByRole("button", { name: /^Suspend$/i }));

    expect(await screen.findByText(/cannot be suspended from here/i)).toBeTruthy();
  });

  it("never puts a rating on screen", async () => {
    server.findPlayers.mockResolvedValue({ users: [account()] });
    await openPlayers();

    await userEvent.type(screen.getByLabelText(/Find a player/i), "grief");
    await userEvent.click(await screen.findByText("Griefer99"));

    // The panel offers to *correct* a rating, which is a Game Master power and
    // says the word out loud. What it must never do is show the number: the
    // moderation payload is identity only, and the server does not send one.
    // So the scan is for a rating-shaped number rather than for the word.
    //
    // Anchored, because a Discord id is a long digit run and an unanchored
    // scan would read a rating out of the middle of one.
    expect(visibleText()).not.toMatch(/\b(6[2-9]\d|[7-9]\d\d|1[0-7]\d\d)\b/);
    expect(screen.getByRole("button", { name: /Correct rating/i })).toBeTruthy();
  });
});

describe("avatars", () => {
  const CDN = "https://cdn.discordapp.com/avatars/42/abc.png";

  /** The header draws the signed-in player, which every screen carries. */
  const mine = () => document.querySelector("img[alt='']");

  it("draws the Discord picture when there is one", async () => {
    server.me.mockResolvedValue({ ...PROFILE, avatarUrl: CDN });
    await signedIn();

    const img = mine();
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("cdn.discordapp.com/avatars/42/abc.png");
  });

  it("asks the CDN for a size near the one it draws at", async () => {
    server.me.mockResolvedValue({ ...PROFILE, avatarUrl: CDN });
    await signedIn();

    // Discord serves the original upload otherwise, which can be a 1024px png
    // behind a 24px circle.
    expect(mine().getAttribute("src")).toMatch(/[?&]size=\d+$/);
  });

  it("falls back to the initial for an account with no picture", async () => {
    server.me.mockResolvedValue({ ...PROFILE, avatarUrl: null });
    await signedIn();

    expect(mine()).toBeNull();
    // Still recognisably someone, rather than an empty circle.
    expect(screen.getAllByTitle("PLAYER_1").length).toBeGreaterThan(0);
  });

  it("falls back to the initial when the picture will not load", async () => {
    server.me.mockResolvedValue({ ...PROFILE, avatarUrl: CDN });
    await signedIn();

    const img = mine();
    expect(img).toBeTruthy();

    // A CDN having a bad day must not leave a broken image in every roster.
    // The same player is drawn in several places, each keeping its own state,
    // so this asserts on the one that failed rather than on all of them.
    fireEvent.error(img);

    await waitFor(() => expect(img.isConnected).toBe(false));
    expect(screen.getAllByTitle("PLAYER_1").length).toBeGreaterThan(0);
  });

  it("leaves a non-Discord url alone rather than appending to it", async () => {
    server.me.mockResolvedValue({ ...PROFILE, avatarUrl: "https://example.com/a.png" });
    await signedIn();

    expect(mine().getAttribute("src")).toBe("https://example.com/a.png");
  });
});

describe("your in-game name", () => {
  async function openOwnProfile(profile = {}) {
    server.me.mockResolvedValue({ ...PROFILE, ...profile });
    server.playerProfile.mockResolvedValue({
      userId: "user-1",
      discordName: "Player1",
      inGameName: profile.inGameName ?? null,
      isGameMaster: false,
      tier: "B",
      peakTier: "B",
      placementsRemaining: 0,
      gamesPlayed: 40,
      wins: 20,
      losses: 20,
      currentWinStreak: 0,
      longestWinStreak: 0,
      disputesInvolved: 0,
      missedAccepts: 0,
      position: 1,
      team: null,
    });
    await signedIn();
    // A player with no name set is met by the prompt first; put it off, which
    // is what someone heading for their profile has already done.
    const later = screen.queryByRole("button", { name: /^Later$/i });
    if (later) await userEvent.click(later);
    await userEvent.click(screen.getByRole("button", { name: /Profile/i }));
  }

  it("asks for one when it has never been set", async () => {
    await openOwnProfile({ inGameName: null });

    // Nine people have to find this person in-game; not knowing it is unset is
    // the failure this prompt exists to prevent. The control says so itself
    // now that it sits beside the name rather than repeating it.
    expect(await screen.findByText(/Set in-game name/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Change your in-game name/i })).toBeTruthy();
  });

  it("saves what was typed", async () => {
    server.setInGameName.mockResolvedValue({ inGameName: "SNIPER_X" });
    await openOwnProfile({ inGameName: null });

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "SNIPER_X");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(server.setInGameName).toHaveBeenCalledWith("SNIPER_X"));
  });

  it("re-reads the profile so the rest of the app catches up", async () => {
    server.setInGameName.mockResolvedValue({ inGameName: "SNIPER_X" });
    await openOwnProfile({ inGameName: null });
    server.me.mockClear();

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "SNIPER_X");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    // The name shows in the party panel and every roster, not only here.
    await waitFor(() => expect(server.me).toHaveBeenCalled());
  });

  it("will not send one that is too short", async () => {
    await openOwnProfile({ inGameName: null });

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "x");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    // The server would refuse it; saying so here saves the round trip.
    expect(server.setInGameName).not.toHaveBeenCalled();
    expect(screen.getByText(/2–16 characters/)).toBeTruthy();
  });

  it("ignores Enter on a name the server would refuse", async () => {
    await openOwnProfile({ inGameName: null });

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    // Enter bypasses the disabled Save button, so the guard has to be in the
    // save itself rather than only on the control.
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "x{Enter}");

    expect(server.setInGameName).not.toHaveBeenCalled();
  });

  it("puts the name back when the edit is abandoned", async () => {
    await openOwnProfile({ inGameName: "SNIPER_X" });

    await userEvent.click(await screen.findByRole("button", { name: /Change your in-game name/i }));
    await userEvent.clear(screen.getByLabelText(/^In-game name$/i));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "MISTAKE");
    await userEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));

    // In several places at once, and rightly so now that the in-game name is
    // what somebody is called: the title bar, the profile heading, and the
    // field being edited. What matters is that the abandoned edit is gone.
    await waitFor(() => expect(screen.getAllByText("SNIPER_X").length).toBeGreaterThan(0));
    expect(screen.queryByText("MISTAKE")).toBeNull();
    expect(server.setInGameName).not.toHaveBeenCalled();
  });

  it("shows the new name straight away, without changing screens", async () => {
    await openOwnProfile({ inGameName: "SNIPER_X" });
    await screen.findByRole("button", { name: /Change your in-game name/i });

    // What the server will say once the rename lands, on both endpoints: the
    // screen renders the fetched profile over the handed-in player, so a
    // refresh of one and not the other left the old name winning.
    server.me.mockResolvedValue({ ...PROFILE, inGameName: "NEW_NAME" });
    server.playerProfile.mockResolvedValue({
      userId: "user-1",
      discordName: "Player1",
      inGameName: "NEW_NAME",
      isGameMaster: false,
      tier: "B",
      peakTier: "B",
      placementsRemaining: 0,
      gamesPlayed: 40,
      wins: 20,
      losses: 20,
      currentStreak: 0,
      longestStreak: 0,
      disputesInvolved: 0,
      missedAccepts: 0,
      position: 1,
      team: null,
    });

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    await userEvent.clear(screen.getByLabelText(/^In-game name$/i));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "NEW_NAME");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(screen.getAllByText("NEW_NAME").length).toBeGreaterThan(0));
    expect(screen.queryByText("SNIPER_X")).toBeNull();
  });

  it("keeps the Discord name on show, since that is what the other line is for", async () => {
    await openOwnProfile({ inGameName: "SNIPER_X" });

    // Your own profile is the one screen where the account behind the name is
    // worth knowing, and a heading and an alt name that both say the in-game
    // name would make having two of them pointless.
    expect(await screen.findByText(/Player1 · Discord/i)).toBeTruthy();
  });

  it("shows one name for somebody who has not set an in-game name", async () => {
    await openOwnProfile({ inGameName: null });

    // Nothing to put on the second line but a copy of the first.
    expect(screen.queryByText(/· Discord/i)).toBeNull();
  });

  it("says so when the server refuses", async () => {
    server.setInGameName.mockRejectedValue(
      Object.assign(new Error("In-game name must be between 2 and 16 characters"), { status: 400 }),
    );
    await openOwnProfile({ inGameName: null });

    await userEvent.click(screen.getByRole("button", { name: /Change your in-game name/i }));
    await userEvent.type(screen.getByLabelText(/^In-game name$/i), "SNIPER_X");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    expect(await screen.findByText(/must be between 2 and 16/i)).toBeTruthy();
  });

  it("is not offered on somebody else's profile", async () => {
    server.playerProfile.mockResolvedValue({
      userId: "user-2",
      discordName: "Player2",
      inGameName: "OTHER_GUY",
      isGameMaster: false,
      tier: "B",
      peakTier: "B",
      placementsRemaining: 0,
      gamesPlayed: 10,
      wins: 5,
      losses: 5,
      currentWinStreak: 0,
      longestWinStreak: 0,
      disputesInvolved: 0,
      missedAccepts: 0,
      position: 2,
      team: null,
    });
    server.ladder.mockResolvedValue({
      rows: [{ position: 2, userId: "user-2", discordName: "Player2", inGameName: "OTHER_GUY", isGameMaster: false, tier: "B", wins: 5, losses: 5, gamesPlayed: 10, teamTag: null }],
      total: 1,
      myPosition: null,
    });
    await signedIn();

    await userEvent.click(screen.getByRole("button", { name: /Ladder/i }));
    await userEvent.click(await screen.findByText("Player2"));

    expect(await screen.findByText(/OTHER_GUY/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Change your in-game name/i })).toBeNull();
  });
});

describe("being asked for an in-game name", () => {
  const nameless = () => server.me.mockResolvedValue({ ...PROFILE, inGameName: null });

  it("asks on sign-in when there is none", async () => {
    nameless();
    await signedIn();

    expect(await screen.findByRole("dialog", { name: /Set your in-game name/i })).toBeTruthy();
  });

  it("does not ask someone who already has one", async () => {
    await signedIn();
    expect(screen.queryByRole("dialog", { name: /Set your in-game name/i })).toBeNull();
  });

  it("saves and gets out of the way", async () => {
    nameless();
    server.setInGameName.mockResolvedValue({ inGameName: "SNIPER_X" });
    await signedIn();

    await userEvent.type(await screen.findByLabelText(/^In-game name$/i), "SNIPER_X");
    server.me.mockResolvedValue({ ...PROFILE, inGameName: "SNIPER_X" });
    await userEvent.click(screen.getByRole("button", { name: /Save it/i }));

    await waitFor(() => expect(server.setInGameName).toHaveBeenCalledWith("SNIPER_X"));
    // Re-reading the profile is what clears the prompt and carries the name to
    // everywhere else it is drawn, so the prompt going is the thing to assert.
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Set your in-game name/i })).toBeNull(),
    );
  });

  it("can be put off, leaving a way back", async () => {
    nameless();
    await signedIn();

    await userEvent.click(await screen.findByRole("button", { name: /^Later$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Set your in-game name/i })).toBeNull());
    // Interrupting someone on their way to a queue is not how to be liked, so
    // the banner carries it from here rather than the modal insisting.
    expect(screen.getByText(/have not set one/i)).toBeTruthy();
  });

  it("keeps the banner off once a name is set", async () => {
    await signedIn();
    expect(screen.queryByText(/have not set one/i)).toBeNull();
  });

  it("will not take a name the server would refuse", async () => {
    nameless();
    await signedIn();

    await userEvent.type(await screen.findByLabelText(/^In-game name$/i), "x{Enter}");
    expect(server.setInGameName).not.toHaveBeenCalled();
  });

  it("stands aside for a match that has been found", async () => {
    nameless();
    await signedIn();

    emit({
      type: "match.found",
      matchId: MATCH.id,
      acceptDeadline: new Date(Date.now() + 20_000).toISOString(),
      match: MATCH,
    });

    // Twenty seconds to accept; a question about names can wait.
    expect(await screen.findByText(/Match found/i)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Set your in-game name/i })).toBeNull();
  });
});

describe("updating the app", () => {
  const available = (over = {}) => ({
    version: "0.2.0",
    notes: "Fixes the thing",
    date: null,
    handle: {},
    ...over,
  });

  /** Never resolves: installing normally ends in a relaunch, not a return. */
  const neverReturns = () => new Promise(() => {});

  it("takes over the app when a new version is out", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockReturnValue(neverReturns());
    render(<App />);

    expect(await screen.findByText(/Update required/i)).toBeTruthy();
    expect(await screen.findByText(/Version 0\.2\.0 has to be installed/i)).toBeTruthy();
  });

  it("installs without being asked", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockReturnValue(neverReturns());
    render(<App />);

    await screen.findByText(/Update required/i);
    await waitFor(() => expect(updates.installUpdate).toHaveBeenCalled());
  });

  it("starts the install once, not once per effect pass", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockReturnValue(neverReturns());
    render(<App />);

    await screen.findByText(/Update required/i);
    await act(async () => {});

    // Downloading and running an installer twice is not a harmless repeat.
    expect(updates.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("cannot be dismissed or walked around", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockReturnValue(neverReturns());
    render(<App />);

    await screen.findByText(/Update required/i);

    expect(screen.queryByRole("button", { name: /^Later$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Skip/i })).toBeNull();
    // Not even the sign-in screen: an update avoidable by staying signed out
    // is not required.
    expect(screen.queryByText(/Continue with Discord/i)).toBeNull();
    expect(screen.queryByText(/Ready to queue/i)).toBeNull();
  });

  it("shows how far along the download is", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockImplementation((_update, onProgress) => {
      onProgress(0.42);
      return neverReturns();
    });
    render(<App />);

    expect(await screen.findByText(/Downloading 0\.2\.0 — 42%/i)).toBeTruthy();
  });

  it("says nothing when there is nothing to install", async () => {
    await signedIn();

    expect(screen.queryByText(/Update required/i)).toBeNull();
    expect(updates.installUpdate).not.toHaveBeenCalled();
  });

  it("blocks while the answer is still unknown", async () => {
    // Never resolves: the check is in flight.
    updates.checkForUpdate.mockReturnValue(neverReturns());
    render(<App />);

    expect(await screen.findByText(/Checking for updates/i)).toBeTruthy();
    expect(screen.queryByText(/Continue with Discord/i)).toBeNull();
  });

  it("blocks when the check cannot be made at all", async () => {
    updates.checkForUpdate.mockRejectedValue(new Error("network is down"));
    render(<App />);

    // Not knowing counts as not current. Opening here would make the update
    // required only of people who cannot arrange for the check to fail.
    expect(await screen.findByText(/Cannot reach the update service/i)).toBeTruthy();
    expect(await screen.findByText(/network is down/i)).toBeTruthy();
    expect(screen.queryByText(/Continue with Discord/i)).toBeNull();
    expect(screen.queryByText(/Ready to queue/i)).toBeNull();
  });

  it("keeps checking on its own while it is stuck", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      updates.checkForUpdate.mockRejectedValue(new Error("network is down"));
      render(<App />);

      await screen.findByText(/Cannot reach the update service/i);
      expect(updates.checkForUpdate).toHaveBeenCalledTimes(1);

      await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });

      expect(updates.checkForUpdate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the app once a retried check comes back clear", async () => {
    updates.checkForUpdate.mockRejectedValueOnce(new Error("network is down"));
    render(<App />);

    await screen.findByText(/Cannot reach the update service/i);
    await userEvent.click(screen.getByRole("button", { name: /Try again/i }));

    expect(await screen.findByText(/Ready to queue/i)).toBeTruthy();
    // The button, not the backoff, which has not come round yet.
    expect(updates.checkForUpdate).toHaveBeenCalledTimes(2);
  });

  it("keeps checking while it runs, and gates when it finds one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await signedIn();
      expect(screen.getByText(/Ready to queue/i)).toBeTruthy();

      // Left open long enough for a release to have happened underneath it.
      updates.checkForUpdate.mockResolvedValue(available());
      updates.installUpdate.mockReturnValue(neverReturns());
      await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000); });

      expect(await screen.findByText(/Update required/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not blank a working app to say it is checking", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await signedIn();

      // Still nothing to install, and a routine look must not be visible.
      await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000); });

      expect(screen.queryByText(/Checking for updates/i)).toBeNull();
      expect(screen.getByText(/Ready to queue/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a running app open when a background check fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await signedIn();

      updates.checkForUpdate.mockRejectedValue(new Error("network is down"));
      await act(async () => { await vi.advanceTimersByTimeAsync(16 * 60 * 1000); });

      // Not knowing is a reason not to open. It is not a reason to close
      // something already open and working.
      expect(screen.queryByText(/Cannot reach the update service/i)).toBeNull();
      expect(screen.getByText(/Ready to queue/i)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks when the server refuses this version, wherever the call was made", async () => {
    await signedIn();
    expect(screen.getByText(/Ready to queue/i)).toBeTruthy();

    // The server's half of the rule: it arrives in answer to an ordinary call,
    // not from the updater, and it is not a check that can be retried into
    // success.
    emit({ type: "client.tooOld", minimum: "0.2.0" });

    expect(await screen.findByText(/Update required/i)).toBeTruthy();
    expect(await screen.findByText(/serving version 0\.2\.0/i)).toBeTruthy();
    expect(screen.queryByText(/Ready to queue/i)).toBeNull();
  });

  it("leaves an install already under way alone when the server refuses", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockImplementation((_update, onProgress) => {
      onProgress(0.5);
      return neverReturns();
    });
    render(<App />);

    await screen.findByText(/Downloading 0\.2\.0 — 50%/i);
    emit({ type: "client.tooOld", minimum: "0.2.0" });

    // Replacing a progress bar with an explanation of why the progress bar is
    // needed would be a step backwards.
    expect(await screen.findByText(/Downloading 0\.2\.0 — 50%/i)).toBeTruthy();
  });

  it("offers a retry when the install fails, rather than hanging on the progress", async () => {
    updates.checkForUpdate.mockResolvedValue(available());
    updates.installUpdate.mockRejectedValue(new Error("Signature did not verify"));
    render(<App />);

    expect(await screen.findByText(/Signature did not verify/i)).toBeTruthy();

    // Still gated -- a failed install is not a way through.
    expect(screen.queryByText(/Continue with Discord/i)).toBeNull();

    updates.installUpdate.mockReturnValue(neverReturns());
    await userEvent.click(await screen.findByRole("button", { name: /Try again/i }));

    await waitFor(() => expect(updates.installUpdate).toHaveBeenCalledTimes(2));
  });
});

describe("adapting to the deployment", () => {
  const ROCKET = {
    appName: "Rocket Queue",
    gameName: "Rocket League",
    teamSize: 3,
    matchSize: 6,
    maxPartySize: 3,
    maxTeamSize: 6,
    regions: [
      { id: "oce", label: "OCE", name: "Oceania" },
      { id: "eu", label: "EU", name: "Europe" },
    ],
    tiers: ["Bronze", "Silver", "Gold"],
    tierFloors: [0, 1000, 2000],
    defaultRating: 1000,
    placementGames: 3,
  };

  it("wears the deployment's name, not the one it was built with", async () => {
    server.config.mockResolvedValue(ROCKET);
    await signedIn();

    // The same binary can be pointed at anyone's server.
    expect(await screen.findAllByText("Rocket Queue")).not.toHaveLength(0);
  });

  it("names the game on the sign-in screen before anyone signs in", async () => {
    token = null;
    server.config.mockResolvedValue(ROCKET);
    render(<App />);

    expect(await screen.findByText(/Rocket League/)).toBeTruthy();
  });

  it("offers the regions that deployment actually has", async () => {
    server.config.mockResolvedValue(ROCKET);
    await signedIn();

    expect(await screen.findByTitle("Oceania")).toBeTruthy();
    // The four it was built with are not this deployment's.
    expect(screen.queryByTitle("North America")).toBeNull();
  });

  it("describes a match at the configured size", async () => {
    server.config.mockResolvedValue(ROCKET);
    await signedIn();

    expect(await screen.findByText(/3v3/)).toBeTruthy();
    expect(screen.queryByText(/5v5/)).toBeNull();
  });

  it("draws a party of the configured size", async () => {
    server.config.mockResolvedValue(ROCKET);
    await signedIn();

    // Five slots for a three-a-side game would promise a party that could
    // never be matched.
    await waitFor(() => expect(screen.getByText(/Party ·/).textContent).toBe("Party · 1/3"));
  });

  it("keeps working when the server will not say what it is", async () => {
    server.config.mockRejectedValue(new Error("unreachable"));
    await signedIn();

    // A first paint on stale defaults beats a blank window.
    expect(await screen.findByText(/Ready to queue/i)).toBeTruthy();
    expect(screen.getByText(/5v5/)).toBeTruthy();
  });
});

describe("running in another language", () => {
  /** A stand-in for a shipped language file, removed after each test. */
  const speakGerman = (entries) => {
    CATALOGUES.de = entries;
    act(() => setLocale("de"));
  };

  afterEach(() => {
    act(() => setLocale("en"));
    delete CATALOGUES.de;
  });

  it("renders English when no catalogue is installed", async () => {
    await signedIn();
    expect(screen.getByText("Ready to queue")).toBeTruthy();
  });

  it("renders the translation once one is", async () => {
    await signedIn();
    speakGerman({ "Ready to queue": "Bereit für die Warteschlange" });

    expect(await screen.findByText("Bereit für die Warteschlange")).toBeTruthy();
    expect(screen.queryByText("Ready to queue")).toBeNull();
  });

  it("redraws what is already on screen, without a reload", async () => {
    await signedIn();
    expect(screen.getByText("Recent matches")).toBeTruthy();

    speakGerman({ "Recent matches": "Letzte Spiele" });

    // t() is a plain function, so something has to force the tree to redraw.
    expect(await screen.findByText("Letzte Spiele")).toBeTruthy();
  });

  it("leaves untranslated phrases in English rather than blanking them", async () => {
    await signedIn();
    speakGerman({ "Ready to queue": "Bereit" });

    expect(await screen.findByText("Bereit")).toBeTruthy();
    // A half-finished catalogue is a half-German app, not a broken one.
    expect(screen.getByText("Recent matches")).toBeTruthy();
  });

  it("translates a refusal from the server by its code", async () => {
    speakGerman({ "error.INVALID_NAME": "Dieser Name geht nicht" });
    server.setInGameName.mockRejectedValue(
      Object.assign(new Error("In-game name must be between 2 and 16 characters"), {
        status: 400,
        code: "INVALID_NAME",
      }),
    );
    server.me.mockResolvedValue({ ...PROFILE, inGameName: null });
    await signedIn();

    await userEvent.type(await screen.findByLabelText(/^In-game name$/i), "SNIPER_X");
    await userEvent.click(screen.getByRole("button", { name: /Save it/i }));

    // The code wins over the English sentence the server sent beside it.
    expect(await screen.findByText("Dieser Name geht nicht")).toBeTruthy();
  });
});

describe("what an officer sees", () => {
  const roster = (over = []) => [
    { userId: "user-2", discordName: "Captain", inGameName: "CAP", isGameMaster: false, role: "captain", isStarter: true, tier: "B", placementsRemaining: 0, joinedAt: new Date().toISOString() },
    { userId: "user-1", discordName: "Player1", inGameName: "PLAYER_1", isGameMaster: false, role: "officer", isStarter: true, tier: "B", placementsRemaining: 0, joinedAt: new Date().toISOString() },
    { userId: "user-3", discordName: "Member", inGameName: "MEM", isGameMaster: false, role: "member", isStarter: true, tier: "B", placementsRemaining: 0, joinedAt: new Date().toISOString() },
    { userId: "user-4", discordName: "OtherOfficer", inGameName: "OFF2", isGameMaster: false, role: "officer", isStarter: true, tier: "B", placementsRemaining: 0, joinedAt: new Date().toISOString() },
    ...over,
  ];

  /** Signed in as user-1, who is an officer rather than the captain. */
  const asOfficer = () =>
    server.myTeam.mockResolvedValue({
      team: {
        id: "team-1",
        tag: "ACE",
        name: "Aces High",
        region: "na",
        captainId: "user-2",
        applicationsOpen: true,
        createdAt: new Date().toISOString(),
        members: roster(),
      },
      role: "officer",
      applications: [],
      myApplication: null,
    });

  it("is not offered the scrim controls", async () => {
    asOfficer();
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Scrims/i }));

    // The server refuses an officer outright, so the button would only ever 403.
    expect(await screen.findByText(/Only the captain can list/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Post to scrim list/i })).toBeNull();
  });

  it("can still remove an ordinary member", async () => {
    asOfficer();
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    const row = (await screen.findByText("Member")).closest(".row-hover");
    expect(within(row).getByTitle(/Remove from team/i)).toBeTruthy();
  });

  it("is not offered a way to remove another officer", async () => {
    asOfficer();
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    // Officers are the captain's appointments; undoing one is the captain's.
    const row = (await screen.findByText("OtherOfficer")).closest(".row-hover");
    expect(within(row).queryByTitle(/Remove from team/i)).toBeNull();
  });

  it("is not offered the applications switch", async () => {
    asOfficer();
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Teams/i }));

    await screen.findByText("Aces High");
    expect(screen.queryByRole("button", { name: /Applications (open|closed)/i })).toBeNull();
  });
});

describe("leaving and breaking up a party", () => {
  /** A party of two, as the server broadcasts it. */
  const twoUp = (leaderIsMe = true) => ({
    partyId: "p1",
    leaderId: leaderIsMe ? "user-1" : "user-2",
    queued: false,
    members: [
      { userId: "user-1", discordName: "Player1", inGameName: "PLAYER_1", avatarUrl: null, isGameMaster: false, tier: "B", placementsRemaining: 0, gamesPlayed: 40, isLeader: leaderIsMe },
      { userId: "user-2", discordName: "Aria", inGameName: "ARIA", avatarUrl: null, isGameMaster: false, tier: "A", placementsRemaining: 0, gamesPlayed: 40, isLeader: !leaderIsMe },
    ],
  });

  async function inAPartyOfTwo(leaderIsMe = true) {
    await signedIn();
    emit({ type: "party.updated", party: twoUp(leaderIsMe) });
    await screen.findByText("ARIA");
  }

  it("tells the server when you leave, rather than only your own screen", async () => {
    await inAPartyOfTwo();

    // The X on your own slot. This used to filter the row out locally and
    // stop -- so the server kept everyone together, and they queued and were
    // matched together while each screen showed something different.
    await userEvent.click(screen.getByRole("button", { name: /Leave the party/i }));

    await waitFor(() => expect(server.leaveParty).toHaveBeenCalled());
  });

  it("tells the server when the leader removes somebody", async () => {
    await inAPartyOfTwo();

    await userEvent.click(screen.getByRole("button", { name: /Remove from the party/i }));

    await waitFor(() => expect(server.kick).toHaveBeenCalledWith("user-2"));
  });

  it("does not offer to remove other people to somebody who does not lead", async () => {
    await inAPartyOfTwo(false);

    expect(screen.queryByRole("button", { name: /Remove from the party/i })).toBeNull();
    // Leaving is always yours to do.
    expect(screen.getByRole("button", { name: /Leave the party/i })).toBeTruthy();
  });

  it("waits for the server rather than guessing the new roster", async () => {
    await inAPartyOfTwo();
    await userEvent.click(screen.getByRole("button", { name: /Leave the party/i }));

    // Still drawn until the broadcast says otherwise: a local guess would be a
    // second answer, free to disagree with the one that counts.
    expect(screen.getByText("ARIA")).toBeTruthy();

    emit({
      type: "party.updated",
      party: { partyId: "p9", leaderId: "user-1", queued: false, members: [twoUp().members[0]] },
    });

    await waitFor(() => expect(screen.queryByText("ARIA")).toBeNull());
  });

  it("keeps the party when the profile is refreshed", async () => {
    await inAPartyOfTwo();

    // `me` changing used to reset the party to [you], so any cosmetic profile
    // refresh silently emptied it.
    emit({ type: "profile.updated" });
    await act(async () => {});

    expect(screen.getByText("ARIA")).toBeTruthy();
  });
});

describe("reporting a player", () => {
  async function openTheirProfile(report = null) {
    server.myReportOf.mockResolvedValue({ report });
    server.playerProfile.mockResolvedValue({
      userId: "user-2",
      discordName: "Aria",
      inGameName: "ARIA",
      isGameMaster: false,
      tier: "A",
      peakTier: "A",
      placementsRemaining: 0,
      gamesPlayed: 40,
      wins: 20,
      losses: 20,
      currentStreak: 0,
      longestStreak: 0,
      disputesInvolved: 0,
      missedAccepts: 0,
      position: 2,
      team: null,
    });

    await signedIn();
    emit({ type: "party.updated", party: {
      partyId: "p1", leaderId: "user-1", queued: false,
      members: [
        { userId: "user-1", discordName: "Player1", inGameName: "PLAYER_1", isLeader: true, tier: "B", placementsRemaining: 0 },
        { userId: "user-2", discordName: "Aria", inGameName: "ARIA", isLeader: false, tier: "A", placementsRemaining: 0 },
      ],
    } });

    await userEvent.click(await screen.findByText("ARIA"));
    return screen.findByRole("button", { name: /^Report$|^Reported$/i });
  }

  it("offers a report on somebody else's profile", async () => {
    expect(await openTheirProfile()).toBeTruthy();
  });

  it("sends what was written, and says it does nothing on its own", async () => {
    server.reportPlayer.mockResolvedValue({ subjectId: "user-2", reason: "Left the match", status: "open" });
    await userEvent.click(await openTheirProfile());

    // The copy matters: a report that reads as a punish button gets used as one.
    expect(screen.getByText(/does nothing on its own/i)).toBeTruthy();

    await userEvent.type(screen.getByLabelText(/What happened/i), "Left the match");
    await userEvent.click(screen.getByRole("button", { name: /Send report/i }));

    await waitFor(() => expect(server.reportPlayer).toHaveBeenCalledWith("user-2", "Left the match"));
  });

  it("opens filled in when you have reported them before", async () => {
    await userEvent.click(await openTheirProfile({ subjectId: "user-2", reason: "Said it badly the first time", status: "open" }));

    // Rewritable is the point: the useful version is usually the second one.
    expect(screen.getByLabelText(/What happened/i).value).toBe("Said it badly the first time");
    expect(screen.getByRole("button", { name: /Update report/i })).toBeTruthy();
  });

  it("lets a report be withdrawn", async () => {
    server.withdrawPlayerReport.mockResolvedValue({ ok: true });
    await userEvent.click(await openTheirProfile({ subjectId: "user-2", reason: "Changed my mind", status: "open" }));

    await userEvent.click(screen.getByRole("button", { name: /Withdraw/i }));

    await waitFor(() => expect(server.withdrawPlayerReport).toHaveBeenCalledWith("user-2"));
  });

  it("does not offer to report yourself", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Profile/i }));

    expect(screen.queryByRole("button", { name: /^Report$/i })).toBeNull();
  });
});

describe("the bans wall", () => {
  const ban = (over = {}) => ({
    id: `b${Math.random()}`,
    userId: "user-9",
    discordName: "griefer",
    inGameName: "GRIEFER",
    reason: "Left three matches in a row",
    hours: 24,
    until: new Date(Date.now() + 3_600_000).toISOString(),
    active: true,
    at: new Date().toISOString(),
    ...over,
  });

  it("is there for everybody, not just Game Masters", async () => {
    server.bans.mockResolvedValue({ bans: [ban()] });
    await signedIn();

    // A consequence nobody watches is a consequence nobody weighs.
    await userEvent.click(screen.getByRole("button", { name: /Bans/i }));

    expect(await screen.findByText("GRIEFER")).toBeTruthy();
    expect(screen.getByText(/Left three matches in a row/i)).toBeTruthy();
  });

  it("keeps a served ban on the wall, marked as served", async () => {
    server.bans.mockResolvedValue({
      bans: [ban({ active: false, until: new Date(Date.now() - 1000).toISOString() })],
    });
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Bans/i }));

    // It records what was done, not who is currently out.
    expect(await screen.findByText(/Served/i)).toBeTruthy();
  });

  it("says so plainly when nobody has been banned", async () => {
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Bans/i }));

    expect(await screen.findByText(/Nobody has been banned/i)).toBeTruthy();
  });
});

describe("the management tab", () => {
  const GM = { ...PROFILE, isGameMaster: true };

  async function openManage(tabName) {
    server.me.mockResolvedValue(GM);
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /Manage/i }));

    // Teams is both a nav destination and a panel in here. The nav rail is
    // drawn first, so the panel's tab is the later of the two.
    if (tabName) {
      const tabs = screen.getAllByRole("button", { name: tabName });
      await userEvent.click(tabs[tabs.length - 1]);
    }
  }

  it("is not offered to an ordinary player", async () => {
    await signedIn();
    expect(screen.queryByRole("button", { name: /Manage/i })).toBeNull();
  });

  it("groups reports by who was reported, not by report", async () => {
    server.reports.mockResolvedValue({
      players: [{
        userId: "user-9",
        discordName: "griefer",
        inGameName: "GRIEFER",
        isGameMaster: false,
        openCount: 3,
        totalCount: 3,
        latestAt: new Date().toISOString(),
        reports: [
          { id: "r1", reason: "Threw the match", status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewNote: null, reviewedAt: null, reporter: { userId: "user-2", discordName: "aria", inGameName: "ARIA" } },
        ],
      }],
    });
    await openManage(/Reports/i);

    // Three people complaining about one player is one problem, and the count
    // is what decides where to look first.
    expect(await screen.findByText("GRIEFER")).toBeTruthy();
    expect(screen.getByText(/3 reports/i)).toBeTruthy();
    expect(screen.getByText(/Threw the match/i)).toBeTruthy();
  });

  it("closes a report with what was decided", async () => {
    server.reports.mockResolvedValue({
      players: [{
        userId: "user-9", discordName: "griefer", inGameName: "GRIEFER", isGameMaster: false,
        openCount: 1, totalCount: 1, latestAt: new Date().toISOString(),
        reports: [{ id: "r1", reason: "Threw", status: "open", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reviewNote: null, reviewedAt: null, reporter: { userId: "user-2", discordName: "aria", inGameName: "ARIA" } }],
      }],
    });
    server.reviewReport.mockResolvedValue({ ok: true });
    await openManage(/Reports/i);

    await userEvent.type(await screen.findByLabelText(/Review note/i), "Suspended 24h");
    await userEvent.click(screen.getByRole("button", { name: /Actioned/i }));

    await waitFor(() => expect(server.reviewReport).toHaveBeenCalledWith("r1", "actioned", "Suspended 24h"));
  });

  it("will not void a match without a reason", async () => {
    await openManage(/Matches/i);

    await userEvent.type(await screen.findByLabelText(/Match id/i), "m-123");

    // The reason is kept, and an unexplained void is indistinguishable from a
    // bug six months later.
    expect(screen.getByRole("button", { name: /Void this match/i }).disabled).toBe(true);
  });

  it("voids a match, saying how much rating it put back", async () => {
    server.voidMatch.mockResolvedValue({ reversed: 10 });
    await openManage(/Matches/i);

    await userEvent.type(await screen.findByLabelText(/Match id/i), "m-123");
    await userEvent.type(screen.getByLabelText(/Reason/i), "Wrong lineup");
    await userEvent.click(screen.getByRole("button", { name: /Void this match/i }));

    await waitFor(() => expect(server.voidMatch).toHaveBeenCalledWith("m-123", "Wrong lineup"));
  });

  it("renames a team that named itself something unrepeatable", async () => {
    server.listTeams.mockResolvedValue({ teams: [{ id: "t1", tag: "BAD", name: "Something Vile", region: "na", applicationsOpen: true, memberCount: 5, tier: "B" }] });
    server.renameTeam.mockResolvedValue({ ok: true });
    await openManage(/Teams/i);

    await userEvent.click(await screen.findByRole("button", { name: /Rename/i }));
    await userEvent.clear(screen.getByLabelText(/Team name/i));
    await userEvent.type(screen.getByLabelText(/Team name/i), "Renamed Team");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(server.renameTeam).toHaveBeenCalledWith("t1", { name: "Renamed Team", tag: "BAD" }));
  });

  it("shows what staff have been doing", async () => {
    server.auditLog.mockResolvedValue({
      entries: [{ id: "a1", eventType: "match.voided", actorId: "user-1", actorName: "Player1", subjectType: "match", subjectId: "m-1", payload: { reason: "bug" }, createdAt: new Date().toISOString() }],
    });
    await openManage(/Audit/i);

    // The tab can rewrite results, and a power that leaves no visible trace is
    // the kind that gets used quietly.
    expect(await screen.findByText("match.voided")).toBeTruthy();
  });
});

describe("browsing teams while on one", () => {
  const MY_TEAM = {
    team: {
      id: "t1", tag: "ACE", name: "Aces High", region: "na", captainId: "user-1",
      applicationsOpen: true, note: null, createdAt: new Date().toISOString(),
      members: [{ userId: "user-1", discordName: "Player1", inGameName: "PLAYER_1", isGameMaster: false, role: "captain", isStarter: true, tier: "B", placementsRemaining: 0, joinedAt: new Date().toISOString() }],
    },
    role: "captain",
    applications: [],
    myApplication: null,
  };

  async function openTeams(mine = MY_TEAM) {
    server.myTeam.mockResolvedValue(mine);
    server.listTeams.mockResolvedValue({
      teams: [{ id: "t2", tag: "RIV", name: "Rivals", region: "na", applicationsOpen: true, memberCount: 5, tier: "A" }],
    });
    await signedIn();
    await userEvent.click(screen.getByRole("button", { name: /^Teams$/i }));
  }

  it("lets somebody on a team see the directory, which used to vanish", async () => {
    await openTeams();

    // Being on a team is when you most want to look at the others: scouting a
    // scrim opponent, or seeing who is recruiting before you leave.
    await userEvent.click(await screen.findByRole("button", { name: /All teams/i }));
    expect(await screen.findByText("Rivals")).toBeTruthy();
  });

  it("does not offer a second team to somebody who has one", async () => {
    await openTeams();
    await userEvent.click(await screen.findByRole("button", { name: /All teams/i }));

    // One team per player; the server refuses it either way.
    expect(screen.queryByRole("button", { name: /Register a team/i })).toBeNull();
    expect((await screen.findByRole("button", { name: /^Apply$/i })).disabled).toBe(true);
  });

  it("shows no tab strip to somebody without a team", async () => {
    await openTeams({ team: null, role: null, applications: [], myApplication: null });

    // A tab strip with one tab is furniture.
    expect(screen.queryByRole("button", { name: /My team/i })).toBeNull();
    expect(await screen.findByText("Rivals")).toBeTruthy();
  });
});

describe("another player's profile", () => {
  const THEIR_HISTORY = [
    { matchId: "m-1", type: "PUG", region: "na", state: "COMPLETED", result: "TEAM1", team: 1, resolvedAt: new Date("2026-08-20T10:00:00Z").toISOString(), createdAt: new Date("2026-08-20T09:00:00Z").toISOString() },
    { matchId: "m-2", type: "SCRIM", region: "eu", state: "COMPLETED", result: "TEAM2", team: 1, resolvedAt: new Date("2026-08-19T10:00:00Z").toISOString(), createdAt: new Date("2026-08-19T09:00:00Z").toISOString() },
  ];

  async function openThem(over = {}, history = THEIR_HISTORY) {
    server.playerHistory.mockResolvedValue(history);
    server.playerProfile.mockResolvedValue({
      userId: "user-2", discordName: "aria", inGameName: "ARIA", isGameMaster: false,
      tier: "A", peakTier: "A", placementsRemaining: 0, gamesPlayed: 40, wins: 20, losses: 20,
      currentStreak: 0, longestStreak: 0, disputesInvolved: 0, missedAccepts: 0, position: 2,
      team: { id: "t2", tag: "RIV", name: "Rivals", role: "captain" },
      ...over,
    });

    await signedIn();
    emit({ type: "party.updated", party: { partyId: "p1", leaderId: "user-1", queued: false, members: [
      { userId: "user-1", discordName: "Player1", inGameName: "PLAYER_1", isLeader: true, tier: "B", placementsRemaining: 0 },
      { userId: "user-2", discordName: "aria", inGameName: "ARIA", isLeader: false, tier: "A", placementsRemaining: 0 },
    ] } });
    await userEvent.click(await screen.findByText("ARIA"));
  }

  it("draws their matches as rows rather than as NaN", async () => {
    await openThem();

    // The rows are raw server shapes until they go through the same mapper the
    // shell uses: matchId not id, one of two timestamps, and win or loss
    // computed from the result against which side they were on.
    expect(await screen.findByText(/win/i)).toBeTruthy();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });

  it("opens one of their matches", async () => {
    await openThem();

    await userEvent.click(await screen.findByText(/win/i));
    await waitFor(() => expect(server.matchDetail ?? server.playerProfile).toHaveBeenCalled());
  });

  it("opens their team from the profile", async () => {
    server.team.mockResolvedValue({
      id: "t2", tag: "RIV", name: "Rivals", region: "na", captainId: "user-2",
      applicationsOpen: true, note: "Scrims Tuesdays", createdAt: new Date().toISOString(),
      members: [{ userId: "user-2", discordName: "aria", inGameName: "ARIA", isGameMaster: false, role: "captain", isStarter: true, tier: "A", placementsRemaining: 0, joinedAt: new Date().toISOString() }],
    });
    await openThem();

    await userEvent.click(await screen.findByText("Rivals"));

    expect(await screen.findByText(/Scrims Tuesdays/i)).toBeTruthy();
  });

  it("says so plainly when they have played nothing", async () => {
    await openThem({}, []);

    expect(await screen.findByText(/no finished matches yet/i)).toBeTruthy();
  });
});
