import { MAX_TEAM_SIZE, isFail, isOk } from "@suddenqueue/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { teams } from "../db/schema/index.js";
import { makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { TeamService } from "./service.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let service: TeamService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  service = new TeamService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

/** Registers a team and returns its id plus the captain. */
async function makeTeam(tag = "ACE", region = "na") {
  const captain = await makeUser(handle, { gamesPlayed: 40 });
  const created = await service.create(captain, { tag, name: `${tag} Team`, region });
  if (!isOk(created)) throw new Error(`could not create team: ${JSON.stringify(created)}`);
  return { teamId: created.data.teamId, captain };
}

/** Puts a player on a roster the way an accepted application does. */
async function join(teamId: string, decider: string) {
  const user = await makeUser(handle, { gamesPlayed: 40 });
  const applied = await service.apply(user, teamId, null);
  if (!isOk(applied)) throw new Error("apply failed");
  const decided = await service.decideApplication(decider, applied.data.applicationId, true);
  if (!isOk(decided)) throw new Error(`decide failed: ${JSON.stringify(decided)}`);
  return user;
}

describe("registering", () => {
  it("makes the registrant captain of a roster of one", async () => {
    const { teamId, captain } = await makeTeam();
    const view = await service.view(teamId);

    expect(view!.members).toHaveLength(1);
    expect(view!.captainId).toBe(captain);
    expect(view!.members[0]!.role).toBe("captain");
  });

  it("normalises the tag, since it is an identity people type", async () => {
    const captain = await makeUser(handle);
    const created = await service.create(captain, { tag: " ace ", name: "Aces", region: "na" });
    expect(isOk(created)).toBe(true);

    const view = await service.view((created as { data: { teamId: string } }).data.teamId);
    expect(view!.tag).toBe("ACE");
  });

  it("refuses a tag already in use", async () => {
    await makeTeam("DUP");
    const other = await makeUser(handle);
    const clash = await service.create(other, { tag: "dup", name: "Other", region: "eu" });

    expect(isFail(clash)).toBe(true);
    if (isFail(clash)) expect(clash.code).toBe("TAG_TAKEN");
  });

  it("refuses a second team, because a player has only one", async () => {
    const { captain } = await makeTeam("ONE");
    const again = await service.create(captain, { tag: "TWO", name: "Second", region: "na" });

    expect(isFail(again)).toBe(true);
    if (isFail(again)) expect(again.code).toBe("ALREADY_IN_TEAM");
  });

  it("rejects tags and names that are not usable", async () => {
    const u = await makeUser(handle);
    const cases = [
      { tag: "", name: "Fine", region: "na", code: "INVALID_TAG" },
      { tag: "TOOLONG", name: "Fine", region: "na", code: "INVALID_TAG" },
      { tag: "A B", name: "Fine", region: "na", code: "INVALID_TAG" },
      { tag: "OK", name: "", region: "na", code: "INVALID_NAME" },
      { tag: "OK", name: "Fine", region: "moon", code: "INVALID_REGION" },
    ];

    for (const c of cases) {
      const res = await service.create(u, { tag: c.tag, name: c.name, region: c.region });
      expect(isFail(res)).toBe(true);
      if (isFail(res)) expect(res.code).toBe(c.code);
    }
  });
});

describe("applications", () => {
  it("runs apply through to a place on the roster", async () => {
    const { teamId, captain } = await makeTeam();
    const applicant = await makeUser(handle);

    const applied = await service.apply(applicant, teamId, "I play entry");
    expect(isOk(applied)).toBe(true);

    const pending = await service.pendingApplications(teamId);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.note).toBe("I play entry");

    if (!isOk(applied)) return;
    const decided = await service.decideApplication(captain, applied.data.applicationId, true);
    expect(isOk(decided)).toBe(true);

    const view = await service.view(teamId);
    expect(view!.members.map((m) => m.userId)).toContain(applicant);
    expect(await service.pendingApplications(teamId)).toHaveLength(0);
  });

  it("denying leaves them off the roster", async () => {
    const { teamId, captain } = await makeTeam();
    const applicant = await makeUser(handle);
    const applied = await service.apply(applicant, teamId, null);
    if (!isOk(applied)) throw new Error("apply failed");

    await service.decideApplication(captain, applied.data.applicationId, false);

    const view = await service.view(teamId);
    expect(view!.members).toHaveLength(1);
    expect(await service.pendingApplications(teamId)).toHaveLength(0);
  });

  it("allows only one application at a time", async () => {
    const a = await makeTeam("AAA");
    const b = await makeTeam("BBB");
    const applicant = await makeUser(handle);

    expect(isOk(await service.apply(applicant, a.teamId, null))).toBe(true);

    // Otherwise managers review someone who may have joined elsewhere already.
    const second = await service.apply(applicant, b.teamId, null);
    expect(isFail(second)).toBe(true);
    if (isFail(second)) expect(second.code).toBe("ALREADY_APPLIED");
  });

  it("lets a player withdraw and apply somewhere else", async () => {
    const a = await makeTeam("AAA");
    const b = await makeTeam("BBB");
    const applicant = await makeUser(handle);

    await service.apply(applicant, a.teamId, null);
    expect(isOk(await service.withdrawApplication(applicant))).toBe(true);
    expect(isOk(await service.apply(applicant, b.teamId, null))).toBe(true);
  });

  it("refuses when applications are closed", async () => {
    const { teamId, captain } = await makeTeam();
    await service.setApplicationsOpen(captain, teamId, false);

    const applicant = await makeUser(handle);
    const res = await service.apply(applicant, teamId, null);

    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("APPLICATIONS_CLOSED");
  });

  it("drops a stale application when the applicant joined elsewhere", async () => {
    const a = await makeTeam("AAA");
    const b = await makeTeam("BBB");
    const applicant = await makeUser(handle);

    const applied = await service.apply(applicant, a.teamId, null);
    if (!isOk(applied)) throw new Error("apply failed");

    // They withdraw and join B while A is still sitting on the application.
    await service.withdrawApplication(applicant);
    const joined = await service.apply(applicant, b.teamId, null);
    if (!isOk(joined)) throw new Error("apply failed");
    await service.decideApplication(b.captain, joined.data.applicationId, true);

    const stale = await service.decideApplication(a.captain, applied.data.applicationId, true);
    expect(isFail(stale)).toBe(true);
  });

  it("only lets the captain and officers decide", async () => {
    const { teamId, captain } = await makeTeam();
    const member = await join(teamId, captain);
    const applicant = await makeUser(handle);
    const applied = await service.apply(applicant, teamId, null);
    if (!isOk(applied)) throw new Error("apply failed");

    const byMember = await service.decideApplication(member, applied.data.applicationId, true);
    expect(isFail(byMember)).toBe(true);
    if (isFail(byMember)) expect(byMember.code).toBe("NOT_A_MANAGER");

    await service.setRole(captain, member, "officer");
    expect(isOk(await service.decideApplication(member, applied.data.applicationId, true))).toBe(
      true,
    );
  });

  it("stops accepting once the roster is full", async () => {
    const { teamId, captain } = await makeTeam();
    for (let i = 1; i < MAX_TEAM_SIZE; i += 1) await join(teamId, captain);

    const applicant = await makeUser(handle);
    const res = await service.apply(applicant, teamId, null);

    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("TEAM_FULL");
  });
});

describe("roles", () => {
  it("lets the captain appoint and demote officers", async () => {
    const { teamId, captain } = await makeTeam();
    const member = await join(teamId, captain);

    expect(isOk(await service.setRole(captain, member, "officer"))).toBe(true);
    expect((await service.view(teamId))!.members.find((m) => m.userId === member)!.role).toBe(
      "officer",
    );

    expect(isOk(await service.setRole(captain, member, "member"))).toBe(true);
    expect((await service.view(teamId))!.members.find((m) => m.userId === member)!.role).toBe(
      "member",
    );
  });

  it("does not let an officer appoint other officers", async () => {
    const { teamId, captain } = await makeTeam();
    const officer = await join(teamId, captain);
    const member = await join(teamId, captain);
    await service.setRole(captain, officer, "officer");

    const res = await service.setRole(officer, member, "officer");
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("NOT_CAPTAIN");
  });

  it("hands the team over, and keeps the old captain on as an officer", async () => {
    const { teamId, captain } = await makeTeam();
    const heir = await join(teamId, captain);

    expect(isOk(await service.transferCaptaincy(captain, heir))).toBe(true);

    const view = await service.view(teamId);
    expect(view!.captainId).toBe(heir);
    expect(view!.members.find((m) => m.userId === heir)!.role).toBe("captain");
    expect(view!.members.find((m) => m.userId === captain)!.role).toBe("officer");
  });
});

describe("leaving and removing", () => {
  it("lets managers remove a member", async () => {
    const { teamId, captain } = await makeTeam();
    const member = await join(teamId, captain);

    expect(isOk(await service.removeMember(captain, member))).toBe(true);
    expect((await service.view(teamId))!.members).toHaveLength(1);
  });

  it("will not remove the captain", async () => {
    const { teamId, captain } = await makeTeam();
    const officer = await join(teamId, captain);
    await service.setRole(captain, officer, "officer");

    // Otherwise the team is left pointing at a captain who is not on it.
    const res = await service.removeMember(officer, captain);
    expect(isFail(res)).toBe(true);
    if (isFail(res)) expect(res.code).toBe("CANNOT_REMOVE_CAPTAIN");
  });

  it("passes the captaincy to an officer when the captain leaves", async () => {
    const { teamId, captain } = await makeTeam();
    const member = await join(teamId, captain);
    const officer = await join(teamId, captain);
    await service.setRole(captain, officer, "officer");

    expect(isOk(await service.leave(captain))).toBe(true);

    const view = await service.view(teamId);
    expect(view!.captainId).toBe(officer);
    expect(view!.members.map((m) => m.userId)).not.toContain(captain);
    expect(view!.members.map((m) => m.userId)).toContain(member);
  });

  it("falls back to the longest-serving member when there is no officer", async () => {
    const { teamId, captain } = await makeTeam();
    const first = await join(teamId, captain);
    await join(teamId, captain);

    await service.leave(captain);
    expect((await service.view(teamId))!.captainId).toBe(first);
  });

  it("takes the team with the last person out", async () => {
    const { teamId, captain } = await makeTeam();

    const left = await service.leave(captain);
    expect(isOk(left)).toBe(true);
    if (isOk(left)) expect(left.data.disbanded).toBe(true);
    expect(await service.view(teamId)).toBeNull();
  });

  it("disbands on the captain's word, and only theirs", async () => {
    const { teamId, captain } = await makeTeam();
    const officer = await join(teamId, captain);
    await service.setRole(captain, officer, "officer");

    const byOfficer = await service.disband(officer);
    expect(isFail(byOfficer)).toBe(true);
    if (isFail(byOfficer)) expect(byOfficer.code).toBe("NOT_CAPTAIN");

    const byCaptain = await service.disband(captain);
    expect(isOk(byCaptain)).toBe(true);
    if (isOk(byCaptain)) expect(byCaptain.data.memberIds).toHaveLength(2);

    expect(await service.view(teamId)).toBeNull();
    // Everyone is free to join or register again.
    expect(await service.teamIdFor(officer)).toBeNull();
  });

  it("leaves no applications behind when a team is disbanded", async () => {
    const { teamId, captain } = await makeTeam();
    const applicant = await makeUser(handle);
    await service.apply(applicant, teamId, null);

    await service.disband(captain);

    // Cascaded with the team, so the applicant is free to apply elsewhere.
    expect(await service.myApplication(applicant)).toBeNull();
  });
});

describe("the team list", () => {
  it("filters by region and counts the roster", async () => {
    const na = await makeTeam("NAA", "na");
    await join(na.teamId, na.captain);
    await makeTeam("EUE", "eu");

    const all = await service.list();
    expect(all).toHaveLength(2);

    const naOnly = await service.list("na");
    expect(naOnly).toHaveLength(1);
    expect(naOnly[0]!.memberCount).toBe(2);
  });

  it("ranks a team without publishing a rating", async () => {
    const { teamId } = await makeTeam("RNK");
    const [row] = await service.list();

    expect(row!.id).toBe(teamId);
    expect(row!.tier).toBeTruthy();
    expect(JSON.stringify(row)).not.toMatch(/\b1[0-9]{3}\b/);
  });

  it("ignores unplaced players when ranking, rather than dragging the team down", async () => {
    const captain = await makeUser(handle, { rating: 1700, gamesPlayed: 40 });
    const created = await service.create(captain, { tag: "TOP", name: "Top", region: "na" });
    if (!isOk(created)) throw new Error("create failed");

    const placedOnly = (await service.list())[0]!.tier;

    // A brand-new player joins. Their rating is a placeholder, not a measurement.
    const rookie = await makeUser(handle, { rating: 1200, gamesPlayed: 0 });
    const applied = await service.apply(rookie, created.data.teamId, null);
    if (!isOk(applied)) throw new Error("apply failed");
    await service.decideApplication(captain, applied.data.applicationId, true);

    expect((await service.list())[0]!.tier).toBe(placedOnly);
  });

  it("reports a roster nobody has placed on as unranked", async () => {
    const captain = await makeUser(handle, { gamesPlayed: 0 });
    await service.create(captain, { tag: "NEW", name: "New", region: "na" });

    expect((await service.list())[0]!.tier).toBeNull();
  });
});

describe("the captain column", () => {
  it("always names someone actually on the roster", async () => {
    const { teamId, captain } = await makeTeam();
    const a = await join(teamId, captain);
    await join(teamId, captain);

    await service.setRole(captain, a, "officer");
    await service.leave(captain);
    await service.leave(a);

    const [team] = await handle.db.select().from(teams).where(eq(teams.id, teamId));
    const view = await service.view(teamId);
    expect(view!.members.map((m) => m.userId)).toContain(team!.captainId);
  });
});
