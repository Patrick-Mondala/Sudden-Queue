import { isFail, isOk } from "@suddenqueue/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { makeUser, setupTestDatabase, truncateAll } from "../test/helpers.js";
import { REPORT_REASON_MAX_LENGTH, ReportService } from "./reports.js";

let handle: Awaited<ReturnType<typeof setupTestDatabase>>;
let reports: ReportService;

beforeAll(async () => {
  handle = await setupTestDatabase();
  reports = new ReportService(handle.db);
}, 60_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(async () => {
  await truncateAll(handle);
});

/** A reporter and somebody to report. */
async function two() {
  return { reporter: await makeUser(handle), subject: await makeUser(handle) };
}

describe("filing a report", () => {
  it("records what was said about whom", async () => {
    const { reporter, subject } = await two();

    const r = await reports.file(reporter, subject, "Left the match at 3-0 down");
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.data.reason).toBe("Left the match at 3-0 down");
      expect(r.data.status).toBe("open");
    }
  });

  it("keeps one report per pair, however many times it is filed", async () => {
    const { reporter, subject } = await two();

    await reports.file(reporter, subject, "First attempt");
    await reports.file(reporter, subject, "Actually, here is what happened");

    // The queue should measure how many people have a problem with somebody,
    // not how many times one person clicked.
    const queue = await reports.pending();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.totalCount).toBe(1);
    expect(queue[0]!.reports[0]!.reason).toBe("Actually, here is what happened");
  });

  it("counts separate reporters separately", async () => {
    const subject = await makeUser(handle);
    const a = await makeUser(handle);
    const b = await makeUser(handle);

    await reports.file(a, subject, "Griefing");
    await reports.file(b, subject, "Griefing again");

    const queue = await reports.pending();
    expect(queue).toHaveLength(1);
    expect(queue[0]!.openCount).toBe(2);
  });

  it("refuses a report of yourself", async () => {
    const me = await makeUser(handle);

    const r = await reports.file(me, me, "I am the problem");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("SELF_REPORT");
  });

  it("refuses a report of somebody who does not exist", async () => {
    const reporter = await makeUser(handle);

    const r = await reports.file(reporter, "00000000-0000-0000-0000-000000000000", "Ghost");
    expect(isFail(r)).toBe(true);
    if (isFail(r)) expect(r.code).toBe("SUBJECT_NOT_FOUND");
  });

  it("refuses an empty reason and an essay", async () => {
    const { reporter, subject } = await two();

    expect(isFail(await reports.file(reporter, subject, "   "))).toBe(true);
    expect(
      isFail(await reports.file(reporter, subject, "x".repeat(REPORT_REASON_MAX_LENGTH + 1))),
    ).toBe(true);
  });
});

describe("what the reporter can see and undo", () => {
  it("hands back their own report so the form opens filled in", async () => {
    const { reporter, subject } = await two();
    await reports.file(reporter, subject, "Refused to call rotations");

    const mine = await reports.mine(reporter, subject);
    expect(mine!.reason).toBe("Refused to call rotations");
  });

  it("shows nothing to somebody who has not reported them", async () => {
    const { reporter, subject } = await two();
    expect(await reports.mine(reporter, subject)).toBeNull();
  });

  it("withdraws a report, and says so when there was none", async () => {
    const { reporter, subject } = await two();
    await reports.file(reporter, subject, "Changed my mind about this");

    expect(isOk(await reports.withdraw(reporter, subject))).toBe(true);
    expect(await reports.mine(reporter, subject)).toBeNull();

    const again = await reports.withdraw(reporter, subject);
    expect(isFail(again)).toBe(true);
  });
});

describe("reviewing", () => {
  it("closes a report and takes it off the open queue", async () => {
    const { reporter, subject } = await two();
    const gm = await makeUser(handle);
    await reports.file(reporter, subject, "Verbal abuse in match chat");

    const queued = await reports.pending();
    const reportId = queued[0]!.reports[0]!.id;

    expect(isOk(await reports.review(reportId, gm, "actioned", "Suspended 24h"))).toBe(true);
    expect(await reports.pending()).toHaveLength(0);

    // Still there when asked for everything, with what was decided.
    const all = await reports.pending(true);
    expect(all[0]!.reports[0]!.status).toBe("actioned");
    expect(all[0]!.reports[0]!.reviewNote).toBe("Suspended 24h");
  });

  it("reopens when the reporter rewrites a closed report", async () => {
    const { reporter, subject } = await two();
    const gm = await makeUser(handle);
    await reports.file(reporter, subject, "vague");

    const reportId = (await reports.pending())[0]!.reports[0]!.id;
    await reports.review(reportId, gm, "dismissed", "Not enough to go on");
    expect(await reports.pending()).toHaveLength(0);

    // A dismissed report rewritten with the detail that was missing is a new
    // complaint wearing an old row. Leaving it closed would swallow it.
    await reports.file(reporter, subject, "Here is the detail: he said ...");
    expect(await reports.pending()).toHaveLength(1);
  });

  it("says so when the report is gone", async () => {
    const gm = await makeUser(handle);
    const r = await reports.review(
      "00000000-0000-0000-0000-000000000000",
      gm,
      "dismissed",
      null,
    );
    expect(isFail(r)).toBe(true);
  });
});
