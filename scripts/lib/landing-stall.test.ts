// @vitest-environment node
/*
 * The stall check's judgement of the landing queue, and the refill loop's
 * supervision of it (#2406, #2692, #4458).
 *
 * Loosen it and a stalled or dead queue lander holds every landing back
 * unseen, a lander inside a call is reported dead, the refill loop starts no
 * lander for a waiting ref, or a slow red batch that still moves main, a push
 * onto a main idle for hours, or a machine that was off or asleep, is
 * ticketed as a stall.
 */
import { describe, expect, it } from "vitest";
import { mainMovedAt, stallFindings, supervision } from "./landing-stall.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const Q = "b".repeat(40);
const MIN = 60 * 1000;
/* 2 h and five 60 s beats. */
const STALL_MS = 120 * MIN;
const STALE_MS = 5 * MIN;

type Reading = Parameters<typeof stallFindings>[0];

const stale = (minutes: number) => NOW - STALL_MS - minutes * MIN;

const gauge = (since: number | null) => ({
	now: NOW,
	waiting: since === null ? [] : [{ name: "fix-it", sha: Q, since }],
	baseline: { spans: 0, p50Ms: null, p90Ms: null, depthP90: null },
});

const reading = (
	over: Partial<Reading> & { since?: number | null } = {},
): Reading => {
	const { since = stale(6 * 60), ...rest } = over;
	return {
		now: NOW,
		main: "a".repeat(40),
		movedAt: NOW - 10 * MIN,
		gauge: gauge(since),
		wokeAt: NOW - 24 * 60 * MIN,
		heartbeat: { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: null },
		alive: () => false,
		owed: 0,
		...rest,
	};
};

const found = (over: Parameters<typeof reading>[0] = {}) =>
	stallFindings(reading(over));

const tags = (over: Parameters<typeof reading>[0]) =>
	found(over).map((f) => f.tag);

describe("stallFindings", () => {
	it("warns of a stall where main has not moved for 2 h with a queue ref waiting, naming both", () => {
		const f = found({ movedAt: stale(1) });
		expect(f.map((x) => x.tag)).toEqual(["LANDING-STALLED"]);
		expect(f[0]?.line).toBe(
			`main has not moved since 2026-10-21T09:59:00.000Z, over 120 min, with queue/fix-it bbbbbbbbb waiting since ${new Date(stale(6 * 60)).toISOString()}`,
		);
	});

	it("warns of no stall where main moved within 2 h", () => {
		expect(tags({})).toEqual([]);
	});

	it("warns of no stall where the oldest ref was pushed within 2 h, though main has stood for hours (#3303)", () => {
		expect(tags({ movedAt: stale(6 * 60), since: NOW - 4 * MIN })).toEqual([]);
	});

	it("warns of no stall where the machine woke within 2 h, however long main and the ref have stood (#4055)", () => {
		expect(tags({ movedAt: stale(6 * 60), wokeAt: NOW - 4 * MIN })).toEqual([]);
	});

	it("warns of a stall where it has lasted over 2 h since it woke (#4055)", () => {
		expect(tags({ movedAt: stale(6 * 60), wokeAt: stale(1) })).toEqual([
			"LANDING-STALLED",
		]);
	});

	it("warns of nothing where no queue ref waits, however long main has stood and whatever the lander", () => {
		expect(tags({ since: null, movedAt: stale(60), heartbeat: null })).toEqual(
			[],
		);
	});

	it("warns of no stall where the remote has no main", () => {
		expect(tags({ main: null, movedAt: null, alive: () => true })).toEqual([]);
	});

	it("warns of a dead lander where a queue ref waits and the heartbeat is stale", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const f = found({ heartbeat: { pid: 7, at, batch: null } });
		expect(f.map((x) => x.tag)).toEqual(["LANDER-DEAD"]);
		expect(f[0]?.line).toBe(
			`queue/fix-it bbbbbbbbb waits and no queue lander is running, its heartbeat last written ${at}`,
		);
	});

	it("warns of a dead lander where there is no heartbeat at all", () => {
		expect(tags({ heartbeat: null })).toEqual(["LANDER-DEAD"]);
	});

	it("reads a stale heartbeat whose pid still runs as a lander inside a call, not a dead one", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		expect(
			tags({ heartbeat: { pid: 7, at, batch: null }, alive: () => true }),
		).toEqual([]);
	});
});

describe("mainMovedAt", () => {
	const row = (event: "land" | "enqueue", at: number) => ({
		at,
		event,
		ref: "refs/heads/queue/a",
		sha: Q,
	});

	it("is the newest land row where it is later than main's tip, as a lone ref's old commit leaves it", () => {
		expect(
			mainMovedAt(stale(60), [
				row("land", NOW - 30 * MIN),
				row("land", stale(90)),
			]),
		).toBe(NOW - 30 * MIN);
	});

	it("is main's tip where it is newer than every land row, as a push by hand leaves it, and reads no other event", () => {
		expect(
			mainMovedAt(NOW - 10 * MIN, [
				row("land", stale(60)),
				row("enqueue", NOW - MIN),
			]),
		).toBe(NOW - 10 * MIN);
	});
});

describe("supervision", () => {
	const live = { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: null };
	const ticket = { waiting: `queue/fix-it at ${Q}`, movedAt: stale(1) };

	it("starts a lander and files no ticket for a dead lander while main moved within 2 h", () => {
		expect(supervision(reading({ heartbeat: null }))).toEqual({
			start: true,
			ticket: null,
		});
	});

	it("starts a lander for a waiting ref on a fresh beat whose pid has exited", () => {
		expect(supervision(reading({ heartbeat: live }))).toEqual({
			start: true,
			ticket: null,
		});
	});

	it("starts none where no queue ref waits and no drop is owed a decision", () => {
		expect(supervision(reading({ since: null, heartbeat: null }))).toEqual({
			start: false,
			ticket: null,
		});
	});

	it("starts a lander with no queue ref waiting where a drop is owed a decision, and none while a lander runs (#4950)", () => {
		const owed = { since: null, owed: 1 };

		expect(supervision(reading({ ...owed, heartbeat: null }))).toEqual({
			start: true,
			ticket: null,
		});
		expect(
			supervision(reading({ ...owed, heartbeat: live, alive: () => true })),
		).toEqual({ start: false, ticket: null });
	});

	it("files the stall ticket for a dead lander where main has stood 2 h, as a lander failing on every start leaves it", () => {
		expect(
			supervision(reading({ heartbeat: null, movedAt: stale(1) })),
		).toEqual({ start: true, ticket });
	});

	it("files the stall ticket where a running lander has not moved main for 2 h, starting none beside it", () => {
		expect(
			supervision(
				reading({ heartbeat: live, alive: () => true, movedAt: stale(1) }),
			),
		).toEqual({ start: false, ticket });
	});

	it("does nothing where a running lander moved main within 2 h", () => {
		expect(
			supervision(reading({ heartbeat: live, alive: () => true })),
		).toEqual({ start: false, ticket: null });
	});

	it("files no ticket on a stall whose lander is between runs on a fresh beat", () => {
		expect(
			supervision(reading({ heartbeat: live, movedAt: stale(1) })),
		).toEqual({ start: true, ticket: null });
	});
});
