import { TEAM_SIZE, isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { matchParticipants, matches, playerRatings } from "../db/schema/index.js";
import { MatchLifecycle } from "../match/lifecycle.js";
import { MatchReporting } from "../match/reporting.js";
import { PartyService } from "../party/service.js";
import { QueueRepository } from "../queue/repository.js";
import { TeamService } from "../team/service.js";
import { makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { ScrimService } from "./service.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let scrim: ScrimService;
let team: TeamService;
let lifecycle: MatchLifecycle;
let reporting: MatchReporting;
let queue: QueueRepository;
let party: PartyService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  scrim = new ScrimService(handle.db);
  team = new TeamService(handle.db);
  lifecycle = new MatchLifecycle(handle.db);
  reporting = new MatchReporting(handle.db);
  queue = new QueueRepository(handle.db);
  party = new PartyService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

/** A team with a full five, so it can actually scrim. */
async function makeSquad(tag: string, size = TEAM_SIZE) {
  const captain = await makeUser(handle, { gamesPlayed: 40 });
  const created = await team.create(captain, { tag, name: `${tag} Squad`, region: "na" });
  if (!isOk(created)) throw new Error("create failed");
  const teamId = created.data.teamId;

  const members = [captain];
  for (let i = 1; i < size; i += 1) {
    const u = await makeUser(handle, { gamesPlayed: 40 });
    const applied = await team.apply(u, teamId, null);
    if (!isOk(applied)) throw new Error("apply failed");
    await team.decideApplication(captain, applied.data.applicationId, true);
    members.push(u);
  }

  return { teamId, captain, members };
}

/** Posts, requests, accepts, and commits the match the way the route does. */
async function arrangeScrim(host: Awaited<ReturnType<typeof makeSquad>>, guest: Awaited<ReturnType<typeof makeSquad>>) {
  const listing = await scrim.postListing(host.captain, { region: "na", note: "Bo1" });
  if (!isOk(listing)) throw new Error("listing failed");

  const requested = await scrim.request(guest.captain, listing.data.listingId);
  if (!isOk(requested)) throw new Error("request failed");

  const decided = await scrim.decideRequest(host.captain, requested.data.requestId, true);
  if (!isOk(decided)) throw new Error("decide failed");

  const hostLine = (await scrim.lineup(host.teamId))!;
  const guestLine = (await scrim.lineup(guest.teamId))!;

  const committed = await lifecycle.createScrim({
    region: "na",
    team1Id: host.teamId,
    team2Id: guest.teamId,
    team1UserIds: hostLine.userIds,
    team2UserIds: guestLine.userIds,
    captain1: hostLine.captainId,
    captain2: guestLine.captainId,
    team1Rating: hostLine.rating,
    team2Rating: guestLine.rating,
  });

  return { listing: listing.data, requested: requested.data, committed, hostLine, guestLine };
}

describe("listing a team for practice", () => {
  it("goes up, and shows to other teams but not to itself", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");

    const posted = await scrim.postListing(host.captain, { region: "na", note: "Bo1 tonight" });
    expect(isOk(posted)).toBe(true);

    // Your own listing belongs on your team panel, not in the list of teams to
    // ask.
    expect(await scrim.openListings(host.teamId)).toHaveLength(0);

    const seen = await scrim.openListings(guest.teamId);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.tag).toBe("HST");
    expect(seen[0]!.note).toBe("Bo1 tonight");
    expect(seen[0]!.memberCount).toBe(TEAM_SIZE);
  });

  it("refuses a roster that cannot field five", async () => {
    const short = await makeSquad("SHT", 4);

    const res = await scrim.postListing(short.captain, { region: "na", note: null });
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("ROSTER_TOO_SMALL");
  });

  it("allows one listing at a time", async () => {
    const host = await makeSquad("HST");
    await scrim.postListing(host.captain, { region: "na", note: null });

    const again = await scrim.postListing(host.captain, { region: "eu", note: null });
    expect(isFail(again)).toBe(true);
    if (isFail(again)) expect(again.code).toBe("ALREADY_LISTED");
  });

  it("is a manager's job, not a member's", async () => {
    const host = await makeSquad("HST");
    const member = host.members[1]!;

    const res = await scrim.postListing(member, { region: "na", note: null });
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("NOT_A_MANAGER");
  });

  it("clears waiting requests when the listing comes down", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");

    const listing = await scrim.postListing(host.captain, { region: "na", note: null });
    if (!isOk(listing)) throw new Error("listing failed");
    await scrim.request(guest.captain, listing.data.listingId);

    await scrim.removeListing(host.captain);

    // Otherwise the guest waits on an answer that is never coming.
    expect(await scrim.incomingRequests(host.teamId)).toHaveLength(0);
  });
});

describe("asking for a scrim", () => {
  it("reaches the host, and shows as asked on the way back", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    const listing = await scrim.postListing(host.captain, { region: "na", note: null });
    if (!isOk(listing)) throw new Error("listing failed");

    expect(isOk(await scrim.request(guest.captain, listing.data.listingId))).toBe(true);

    const incoming = await scrim.incomingRequests(host.teamId);
    expect(incoming).toHaveLength(1);
    expect(incoming[0]!.tag).toBe("GST");

    expect((await scrim.openListings(guest.teamId))[0]!.requested).toBe(true);
  });

  it("will not let a team ask twice", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    const listing = await scrim.postListing(host.captain, { region: "na", note: null });
    if (!isOk(listing)) throw new Error("listing failed");

    await scrim.request(guest.captain, listing.data.listingId);
    const again = await scrim.request(guest.captain, listing.data.listingId);

    expect(isFail(again)).toBe(true);
    if (isFail(again)) expect(again.code).toBe("ALREADY_REQUESTED");
  });

  it("will not let a team ask itself", async () => {
    const host = await makeSquad("HST");
    const listing = await scrim.postListing(host.captain, { region: "na", note: null });
    if (!isOk(listing)) throw new Error("listing failed");

    const res = await scrim.request(host.captain, listing.data.listingId);
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("OWN_LISTING");
  });
});

describe("committing the match", () => {
  it("puts ten players in a SCRIM with a captain a side", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    const { committed } = await arrangeScrim(host, guest);

    expect(isOk(committed)).toBe(true);
    if (!isOk(committed)) return;

    const view = await lifecycle.view(committed.data.matchId);
    expect(view!.type).toBe("SCRIM");
    expect(view!.team1).toHaveLength(TEAM_SIZE);
    expect(view!.team2).toHaveLength(TEAM_SIZE);
    expect(view!.captain1).toBe(host.captain);
    expect(view!.captain2).toBe(guest.captain);
  });

  it("puts the captain in the five, since they have to report", async () => {
    const big = await makeSquad("BIG", 8);
    const line = await scrim.lineup(big.teamId);

    expect(line!.userIds).toHaveLength(TEAM_SIZE);
    expect(line!.userIds).toContain(big.captain);
    expect(line!.captainId).toBe(big.captain);
  });

  it("refuses to start when someone is already in a match", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    await arrangeScrim(host, guest);

    // A second arrangement over the same people has nobody free to field.
    const hostLine = (await scrim.lineup(host.teamId))!;
    const guestLine = (await scrim.lineup(guest.teamId))!;
    const second = await lifecycle.createScrim({
      region: "na",
      team1Id: host.teamId,
      team2Id: guest.teamId,
      team1UserIds: hostLine.userIds,
      team2UserIds: guestLine.userIds,
      captain1: hostLine.captainId,
      captain2: guestLine.captainId,
      team1Rating: 1200,
      team2Rating: 1200,
    });

    expect(isFail(second)).toBe(true);
    if (isFail(second)) expect(second.code).toBe("PLAYER_BUSY");
  });

  it("refuses to pull someone out of the queue they are waiting in", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");

    // One of the guests queues for a PUG before the scrim is agreed.
    const pid = await party.ensureParty(guest.members[1]!);
    await queue.join({ partyId: pid, regions: ["na"], ratingSnapshot: 1200, size: 1 });

    const hostLine = (await scrim.lineup(host.teamId))!;
    const guestLine = (await scrim.lineup(guest.teamId))!;
    const res = await lifecycle.createScrim({
      region: "na",
      team1Id: host.teamId,
      team2Id: guest.teamId,
      team1UserIds: hostLine.userIds,
      team2UserIds: guestLine.userIds,
      captain1: hostLine.captainId,
      captain2: guestLine.captainId,
      team1Rating: 1200,
      team2Rating: 1200,
    });

    // Quietly taking their queue slot would be worse than not starting.
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("PLAYER_QUEUED");
  });
});

describe("a scrim is unrated", () => {
  it("moves nobody's rating, however it ends", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    const { committed } = await arrangeScrim(host, guest);
    if (!isOk(committed)) throw new Error("commit failed");

    const before = await handle.db.select().from(playerRatings);
    const ratingsBefore = new Map(before.map((r) => [r.userId, r.rating]));

    // Play it through: everyone accepts, it goes live, both captains agree.
    await handle.db
      .update(matchParticipants)
      .set({ acceptedAt: new Date() })
      .where(eq(matchParticipants.matchId, committed.data.matchId));
    await handle.db
      .update(matches)
      .set({ state: "LIVE" })
      .where(eq(matches.id, committed.data.matchId));

    await reporting.report(committed.data.matchId, host.captain, "TEAM1");
    const settled = await reporting.report(committed.data.matchId, guest.captain, "TEAM1");
    expect(isOk(settled)).toBe(true);

    const after = await handle.db.select().from(playerRatings);
    for (const row of after) {
      expect(row.rating).toBe(ratingsBefore.get(row.userId));
    }

    // It is still on the record: who played, and who won.
    const [match] = await handle.db
      .select()
      .from(matches)
      .where(eq(matches.id, committed.data.matchId));
    expect(match!.state).toBe("COMPLETED");
    expect(match!.result).toBe("TEAM1");
    expect(match!.team1Id).toBe(host.teamId);
    expect(match!.team2Id).toBe(guest.teamId);
  });

  it("still counts as a game played, so a scrim is not a way to dodge placements", async () => {
    const host = await makeSquad("HST");
    const guest = await makeSquad("GST");
    const { committed } = await arrangeScrim(host, guest);
    if (!isOk(committed)) throw new Error("commit failed");

    const [before] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, host.captain));

    await handle.db
      .update(matches)
      .set({ state: "LIVE" })
      .where(eq(matches.id, committed.data.matchId));
    await reporting.report(committed.data.matchId, host.captain, "TEAM1");
    await reporting.report(committed.data.matchId, guest.captain, "TEAM1");

    const [after] = await handle.db
      .select()
      .from(playerRatings)
      .where(eq(playerRatings.userId, host.captain));

    expect(after!.gamesPlayed).toBe(before!.gamesPlayed + 1);
    expect(after!.rating).toBe(before!.rating);
  });
});
