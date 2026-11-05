// @vitest-environment node
/*
 * Pins lib/overflow-budget-core.js's budgetOf: the cycle on and around the
 * cycle day, settled spend by cycle, reservations at and above Q, Q read from
 * the table, and the exhausted mark set by a credit refusal and cleared at
 * the next cycle.
 *
 * Loosen one and the loop launches on a key past its grant, keeps retrying a
 * spent key, or counts a cycle's spend from the wrong day (#2609).
 */
import { describe, expect, it } from "vitest";
import { budgetOf, isBudgetSpent } from "./overflow-budget-core.js";

/* Mean 4; a run 0.5 in has an expected remainder of (0.5 + 2.5 + 9.5) / 3,
 * the top point standing at u 3 + tail 7; one 5 in, past u, the tail's 7. */
const TABLE = {
	n: 3,
	meanUsd: 4,
	quantilesUsd: [1, 3, 10],
	tailRemainderUsd: 7,
	landedByHours: [[1, 1]] as [number, number][],
};
const at = (y: number, m: number, d: number, h = 0) =>
	new Date(y, m - 1, d, h).getTime();
const now = at(2026, 10, 25, 12);
const entry = (endedAt: number, costUsd: number, outcome = "priced") => ({
	sessionId: `s${endedAt}`,
	jobId: "0000000a",
	endedAt,
	bytes: 1,
	costUsd,
	outcome,
});
const base = {
	grantUsd: 200,
	cycleDay: 20,
	ledger: [],
	running: [],
	table: TABLE,
	now,
};

describe("the cycle", () => {
	it("starts at local midnight on the cycle day and runs a month", () => {
		const b = budgetOf({ ...base, now: at(2026, 10, 20) });
		expect([b.cycleStart, b.nextCycleStart]).toEqual([
			at(2026, 10, 20),
			at(2026, 11, 20),
		]);
	});

	it("puts the instant before the cycle day in the previous cycle", () => {
		expect(budgetOf({ ...base, now: at(2026, 10, 20) - 1 }).cycleStart).toBe(
			at(2026, 9, 20),
		);
	});

	it("crosses a year boundary", () => {
		const b = budgetOf({ ...base, cycleDay: 28, now: at(2026, 1, 3) });
		expect([b.cycleStart, b.nextCycleStart]).toEqual([
			at(2025, 12, 28),
			at(2026, 1, 28),
		]);
	});

	it("counts settled spend by the cycle of each session's latest write", () => {
		const b = budgetOf({
			...base,
			ledger: [entry(at(2026, 10, 20), 50), entry(at(2026, 10, 20) - 1, 90)],
		});
		expect(b.settledUsd).toBe(50);
		expect(b.headroomUsd).toBe(150);
		expect(b.fit).toBe(37);
	});
});

describe("reservations and fit", () => {
	it("reserves Q for a run with no spend yet, and spend plus remainder above it", () => {
		const b = budgetOf({
			...base,
			running: [
				{ sessionId: "a", spentUsd: null },
				{ sessionId: "b", spentUsd: 0.5 },
				{ sessionId: "c", spentUsd: 5 },
			],
		});
		expect(b.reservedUsd).toBeCloseTo(4 + (0.5 + (0.5 + 2.5 + 9.5) / 3) + 12);
		expect(b.running).toBe(3);
		expect(b.fit).toBe(Math.floor((200 - b.reservedUsd) / 4));
	});

	it("holds a resumed copy at its chain share plus its own spend's remainder (#4369)", () => {
		const b = budgetOf({
			...base,
			running: [{ sessionId: "a", spentUsd: 5, shareUsd: 1 }],
		});
		expect(b.reservedUsd).toBe(1 + 7);
	});

	it("holds a running session's ledger row rather than settling it too", () => {
		const row = entry(at(2026, 10, 24), 5);
		const b = budgetOf({
			...base,
			ledger: [row, entry(at(2026, 10, 24) + 1, 2)],
			running: [{ sessionId: row.sessionId, spentUsd: row.costUsd }],
		});
		expect(b.settledUsd).toBe(2);
		expect(b.reservedUsd).toBe(12);
	});

	it("holds at Q a running session whose spend fell in an earlier cycle", () => {
		const row = entry(at(2026, 10, 19), 50);
		const b = budgetOf({
			...base,
			ledger: [row],
			running: [
				{ sessionId: row.sessionId, spentUsd: row.costUsd, shareUsd: 30 },
			],
		});
		expect(b.reservedUsd).toBe(4);
		expect(b.headroomUsd).toBe(196);
	});

	it("reads Q from the table", () => {
		const b = budgetOf({ ...base, table: { ...TABLE, meanUsd: 8 } });
		expect(b.qUsd).toBe(8);
		expect(b.fit).toBe(25);
	});

	it("fits none once headroom is below Q", () => {
		expect(budgetOf({ ...base, ledger: [entry(now, 197)] }).fit).toBe(0);
		expect(budgetOf({ ...base, ledger: [entry(now, 230)] }).fit).toBe(0);
	});
});

describe("the exhausted mark", () => {
	it("is set by a credit refusal this cycle, and clear at the next", () => {
		const ledger = [entry(at(2026, 10, 24), 3, "key-exhausted")];
		const b = budgetOf({ ...base, ledger });
		expect(b.exhausted).toBe(true);
		expect(b.fit).toBe(0);
		const next = budgetOf({ ...base, ledger, now: at(2026, 11, 20) });
		expect(next.exhausted).toBe(false);
		expect(next.fit).toBe(50);
	});
});

describe("the exhausted mark's time", () => {
	it("is the refusal's own, so a later write does not carry it into the next cycle", () => {
		const ledger = [
			{
				...entry(at(2026, 10, 21), 3, "key-exhausted"),
				refusedAt: at(2026, 10, 19),
			},
		];
		expect(budgetOf({ ...base, ledger }).exhausted).toBe(false);
	});
});

describe("anchored to a Console reading", () => {
	const readAt = at(2026, 10, 25, 6);
	const credit = (remainingUsd: number, expiresOn: string) => ({
		remainingUsd,
		grantUsd: 200,
		grantedOn: "2026-10-01",
		expiresOn,
	});
	const reading = { at: readAt, credits: [credit(170.02, "2026-12-01")] };

	it("takes off only the runs ended after the read, whatever the cycle holds", () => {
		const b = budgetOf({
			...base,
			reading,
			ledger: [entry(readAt - 1, 70), entry(readAt + 1, 10)],
		});
		expect(b.creditUsd).toBeCloseTo(170.02);
		expect(b.settledUsd).toBe(10);
		expect(b.headroomUsd).toBeCloseTo(160.02);
		expect(b.grantUsd).toBe(200);
		expect(b.readAt).toBe(readAt);
	});

	it("takes running reservations off too", () => {
		const b = budgetOf({
			...base,
			reading,
			running: [{ sessionId: "r", spentUsd: null }],
		});
		expect(b.headroomUsd).toBeCloseTo(170.02 - TABLE.meanUsd);
	});

	it("sums every unexpired grant", () => {
		const b = budgetOf({
			...base,
			reading: {
				at: readAt,
				credits: [credit(10, "2026-12-01"), credit(20, "2027-01-01")],
			},
		});
		expect(b.creditUsd).toBe(30);
		expect(b.grantUsd).toBe(400);
	});

	it("drops a grant that expires between reads, with no new read", () => {
		const two = {
			at: readAt,
			credits: [credit(50, "2026-11-01"), credit(170, "2026-12-01")],
		};
		const expiry = Date.UTC(2026, 10, 1);
		expect(budgetOf({ ...base, reading: two, now: expiry - 1 }).creditUsd).toBe(
			220,
		);
		const after = budgetOf({ ...base, reading: two, now: expiry });
		expect(after.creditUsd).toBe(170);
		expect(after.grantUsd).toBe(200);
		expect(after.headroomUsd).toBe(170);
	});

	it("leaves nothing once every grant has expired", () => {
		const b = budgetOf({
			...base,
			reading,
			now: Date.UTC(2026, 11, 1),
		});
		expect([b.creditUsd, b.fit]).toEqual([0, 0]);
		expect(isBudgetSpent(b)).toBe(true);
	});

	it("reads a credit refusal after the read as exhausted", () => {
		const b = budgetOf({
			...base,
			reading,
			ledger: [entry(readAt + 1, 0, "key-exhausted")],
		});
		expect([b.exhausted, b.fit]).toEqual([true, 0]);
		expect(isBudgetSpent(b)).toBe(true);
	});

	it("lets a newer reading clear an older credit refusal", () => {
		const b = budgetOf({
			...base,
			reading,
			ledger: [entry(readAt - 1, 0, "key-exhausted")],
		});
		expect(b.exhausted).toBe(false);
		expect(isBudgetSpent(b)).toBe(false);
	});

	it("counts the key spent on what the reading leaves, not the configured grant", () => {
		const b = budgetOf({
			...base,
			grantUsd: 200,
			reading: { at: readAt, credits: [credit(3, "2026-12-01")] },
		});
		expect(isBudgetSpent(b)).toBe(true);
	});
});
