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
import { budgetOf } from "./overflow-budget-core.js";

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
const entry = (endedAt: number, costUsd: number, outcome = "success") => ({
	sessionId: `s${endedAt}`,
	jobId: "0000000a",
	launchedAt: endedAt - 1000,
	endedAt,
	costUsd,
	costSource: "result" as const,
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

	it("counts settled spend by the cycle each run ended in", () => {
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
