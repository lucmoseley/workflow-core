// @vitest-environment node
/*
 * The stall check's judgement of the landing queue (#2406, spec #2261).
 *
 * Loosen it and a stalled or dead lander holds every landing back unseen, or
 * a lander inside a push or a held queue is reported dead.
 */
import { describe, expect, it } from "vitest";
import { stallFindings } from "./landing-stall.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const L = "b".repeat(40);
const MIN = 60 * 1000;
/* 90 min and five 60 s beats. */
const STALL_MS = 90 * MIN;
const STALE_MS = 5 * MIN;

const reading = (over: Partial<Parameters<typeof stallFindings>[0]> = {}) =>
	stallFindings({
		now: NOW,
		landing: L,
		relation: "ahead",
		oldest: { sha: L, at: NOW - 10 * MIN },
		heartbeat: { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: L },
		alive: () => false,
		...over,
	});

const tags = (over: Parameters<typeof reading>[0]) =>
	reading(over).map((f) => f.tag);

describe("stallFindings", () => {
	it("warns of a stall where the oldest queued commit is over 90 min old, naming it", () => {
		const found = reading({ oldest: { sha: L, at: NOW - STALL_MS - MIN } });
		expect(found.map((f) => f.tag)).toEqual(["LANDING-STALLED"]);
		expect(found[0]?.line).toContain(
			"bbbbbbbbb, committed 2026-10-21T10:29:00.000Z",
		);
	});

	it("warns of no stall where the oldest queued commit is fresh", () => {
		expect(tags({})).toEqual([]);
	});

	it("warns of a stall on a diverged landing too, naming the relation", () => {
		const found = reading({
			relation: "diverged",
			oldest: { sha: L, at: NOW - STALL_MS - MIN },
			heartbeat: null,
		});
		expect(found.map((f) => f.tag)).toEqual(["LANDING-STALLED"]);
		expect(found[0]?.line).toContain("landing is diverged of main");
	});

	it("warns of a dead lander where the heartbeat is stale and landing is ahead", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const found = reading({ heartbeat: { pid: 7, at, batch: L } });
		expect(found.map((f) => f.tag)).toEqual(["LANDER-DEAD"]);
		expect(found[0]?.line).toContain(`last written ${at}`);
	});

	it("warns of a dead lander where there is no heartbeat at all", () => {
		expect(tags({ heartbeat: null })).toEqual(["LANDER-DEAD"]);
	});

	it.each(["equal", "behind"] as const)(
		"warns of no dead lander on a stale heartbeat while landing is %s main",
		(relation) => {
			expect(tags({ relation, oldest: null, heartbeat: null })).toEqual([]);
		},
	);

	it("reads a stale heartbeat whose pid still runs as a lander inside a push, not a dead one", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		expect(
			tags({ heartbeat: { pid: 7, at, batch: L }, alive: () => true }),
		).toEqual([]);
	});

	it("names a held queue, not a dead lander, where the last beat holds at landing's tip", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const hold = {
			landing: L,
			reason: "culprit unconfirmed",
			filed: "Filed #9",
		};
		const found = reading({ heartbeat: { pid: 7, at, batch: null, hold } });
		expect(found.map((f) => f.tag)).toEqual(["LANDING-HELD"]);
		expect(found[0]?.line).toBe(
			"the lander holds landing at bbbbbbbbb: culprit unconfirmed. Filed #9",
		);
	});

	it("names a held queue on a fresh beat too", () => {
		const hold = { landing: L, reason: "r", filed: "f" };
		const at = new Date(NOW).toISOString();
		expect(tags({ heartbeat: { pid: 7, at, batch: null, hold } })).toEqual([
			"LANDING-HELD",
		]);
	});

	it("reads a hold at an older tip, with landing since moved on, as a dead lander", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const hold = { landing: "a".repeat(40), reason: "r", filed: "f" };
		expect(tags({ heartbeat: { pid: 7, at, batch: null, hold } })).toEqual([
			"LANDER-DEAD",
		]);
	});
});
