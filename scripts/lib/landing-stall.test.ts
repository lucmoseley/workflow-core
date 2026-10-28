// @vitest-environment node
/*
 * The stall check's judgement of the landing queue, and the refill loop's
 * supervision of it (#2406, spec #2261, #2692).
 *
 * Loosen it and a stalled or dead lander holds every landing back unseen, a
 * lander inside a push or a held queue is reported dead, or a slow red batch
 * that still moves main, or a push onto a main idle for hours, is ticketed
 * as a stall.
 */
import { describe, expect, it } from "vitest";
import { stallFindings, supervision } from "./landing-stall.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const L = "b".repeat(40);
const MIN = 60 * 1000;
/* 2 h and five 60 s beats. */
const STALL_MS = 120 * MIN;
const STALE_MS = 5 * MIN;

const reading = (over: Partial<Parameters<typeof stallFindings>[0]> = {}) => ({
	now: NOW,
	landing: L,
	relation: "ahead" as const,
	mainAt: NOW - 10 * MIN,
	aheadSince: null,
	heartbeat: { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: L },
	alive: () => false,
	...over,
});

const found = (over: Parameters<typeof reading>[0] = {}) =>
	stallFindings(reading(over));

const tags = (over: Parameters<typeof reading>[0]) =>
	found(over).map((f) => f.tag);

const stale = (minutes: number) => NOW - STALL_MS - minutes * MIN;

describe("stallFindings", () => {
	it("warns of a stall where main's tip is over 2 h old and no move is recorded, naming when it last moved", () => {
		const f = found({ mainAt: stale(1) });
		expect(f.map((x) => x.tag)).toEqual(["LANDING-STALLED"]);
		expect(f[0]?.line).toBe(
			"main has not moved since 2026-10-21T09:59:00.000Z, over 120 min, with landing bbbbbbbbb ahead of it",
		);
	});

	it("warns of no stall where the lander moved main within 2 h, however old its tip commit", () => {
		const heartbeat = {
			pid: 7,
			at: new Date(NOW - MIN).toISOString(),
			batch: L,
			movedAt: new Date(NOW - 30 * MIN).toISOString(),
		};
		expect(tags({ mainAt: stale(60), heartbeat })).toEqual([]);
	});

	it("warns of a stall where the lander's last move is over 2 h old", () => {
		const heartbeat = {
			pid: 7,
			at: new Date(NOW - MIN).toISOString(),
			batch: L,
			movedAt: new Date(stale(1)).toISOString(),
		};
		expect(tags({ mainAt: stale(60), heartbeat })).toEqual(["LANDING-STALLED"]);
	});

	it("counts from main's tip where it is newer than the recorded move, as a push by hand leaves it", () => {
		const heartbeat = {
			pid: 7,
			at: new Date(NOW - MIN).toISOString(),
			batch: L,
			movedAt: new Date(stale(60)).toISOString(),
		};
		expect(tags({ mainAt: NOW - 10 * MIN, heartbeat })).toEqual([]);
	});

	it("warns of no stall where landing went ahead within 2 h, though main has stood for hours (#3303)", () => {
		expect(tags({ mainAt: stale(6 * 60), aheadSince: NOW - 4 * MIN })).toEqual(
			[],
		);
	});

	it("warns of a stall where landing has been ahead over 2 h, naming when main last moved (#3303)", () => {
		const f = found({ mainAt: stale(6 * 60), aheadSince: stale(1) });
		expect(f.map((x) => x.tag)).toEqual(["LANDING-STALLED"]);
		expect(f[0]?.line).toContain(
			`main has not moved since ${new Date(stale(6 * 60)).toISOString()}`,
		);
	});

	it("warns of no stall where main moved recently", () => {
		expect(tags({})).toEqual([]);
	});

	it("warns of no stall where neither main's tip nor a move is known", () => {
		expect(tags({ mainAt: null, alive: () => true })).toEqual([]);
	});

	it("warns of a stall on a diverged landing too, naming the relation", () => {
		const f = found({
			relation: "diverged",
			mainAt: stale(1),
			heartbeat: null,
		});
		expect(f.map((x) => x.tag)).toEqual(["LANDING-STALLED"]);
		expect(f[0]?.line).toContain("with landing bbbbbbbbb diverged from it");
	});

	it.each(["equal", "behind"] as const)(
		"warns of no stall where landing is %s main, however long main has stood",
		(relation) => {
			expect(tags({ relation, mainAt: stale(60), alive: () => true })).toEqual(
				[],
			);
		},
	);

	it("warns of a dead lander where the heartbeat is stale and landing is ahead", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const f = found({ heartbeat: { pid: 7, at, batch: L } });
		expect(f.map((x) => x.tag)).toEqual(["LANDER-DEAD"]);
		expect(f[0]?.line).toContain(`last written ${at}`);
	});

	it("warns of a dead lander where there is no heartbeat at all", () => {
		expect(tags({ heartbeat: null })).toEqual(["LANDER-DEAD"]);
	});

	it.each(["equal", "behind"] as const)(
		"warns of no dead lander on a stale heartbeat while landing is %s main",
		(relation) => {
			expect(tags({ relation, heartbeat: null })).toEqual([]);
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
		const f = found({ heartbeat: { pid: 7, at, batch: null, hold } });
		expect(f.map((x) => x.tag)).toEqual(["LANDING-HELD"]);
		expect(f[0]?.line).toBe(
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

describe("supervision", () => {
	const live = { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: L };
	const none = { start: false, ticket: null };

	it("starts a dead lander, filing no ticket while main moved within 2 h", () => {
		expect(supervision(reading({ heartbeat: null }))).toEqual({
			start: true,
			ticket: null,
		});
	});

	it("starts a dead lander and files the stall ticket where main has stood 2 h, as a lander failing on every start leaves it", () => {
		expect(supervision(reading({ heartbeat: null, mainAt: stale(1) }))).toEqual(
			{ start: true, ticket: { landing: L, movedAt: stale(1) } },
		);
	});

	it("files the stall ticket where a running lander has not moved main for 2 h, naming when it last moved", () => {
		expect(
			supervision(
				reading({ heartbeat: live, alive: () => true, mainAt: stale(1) }),
			),
		).toEqual({ start: false, ticket: { landing: L, movedAt: stale(1) } });
	});

	it("does nothing where a running lander moved main within 2 h", () => {
		expect(
			supervision(reading({ heartbeat: live, alive: () => true })),
		).toEqual(none);
	});

	it("does nothing on a stall whose lander is between runs on a fresh beat", () => {
		expect(supervision(reading({ heartbeat: live, mainAt: stale(1) }))).toEqual(
			none,
		);
	});

	it("leaves a held queue to its held-queue issue", () => {
		const hold = { landing: L, reason: "r", filed: "f" };
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		expect(
			supervision(
				reading({
					heartbeat: { pid: 7, at, batch: null, hold },
					mainAt: stale(1),
				}),
			),
		).toEqual(none);
	});

	it("files nothing on a diverged landing, which no lander can clear", () => {
		expect(
			supervision(
				reading({
					relation: "diverged",
					heartbeat: live,
					alive: () => true,
					mainAt: stale(1),
				}),
			),
		).toEqual(none);
	});
});
