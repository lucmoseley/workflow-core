// @vitest-environment node
/*
 * lib/landing-wait.js (#4617): `landing-status.js --wait` exits on landed,
 * dropped or its bound, each named, off a scripted run of readings.
 *
 * Loosen it and a session waits past its landing, calls a dropped ref landed,
 * or blocks past the harness's 15-minute Bash wait.
 */
import { expect, it } from "vitest";
import {
	buildWaitLine,
	shaState,
	WAIT_BOUND_MS,
	WAIT_POLL_MS,
	waitForLanding,
} from "./landing-wait.js";

type ShaState = "landed" | "pending" | "dropped" | "left";
type Step = Record<string, ShaState> | { fault: number; network: boolean };

const NET = { fault: 1, network: true };
const LEDGER = { fault: 1, network: false };

const A = "a".repeat(40);
const B = "b".repeat(40);

/** Reads `steps` in order, the last repeating; the clock moves only on sleep. */
const scripted = (...steps: Step[]) => {
	let clock = 0;
	let reads = 0;
	const read = () => {
		const step = steps[Math.min(reads++, steps.length - 1)];
		if ("fault" in step && typeof step.fault === "number")
			return { fault: step.fault, network: step.network === true };
		const states = new Map(Object.entries(step as Record<string, ShaState>));
		return { lines: [`read ${reads}`], states };
	};
	const io = {
		sleep: (ms: number) => {
			clock += ms;
		},
		elapsed: () => clock,
	};
	return { read, io, reads: () => reads };
};

it("exits at once, reading once, where nothing is queued", () => {
	const s = scripted({ [A]: "landed" });

	const o = waitForLanding(s.read, s.io);

	expect(o.kind).toBe("idle");
	expect(s.reads()).toBe(1);
	if (o.kind === "fault") throw new Error("fault");
	expect(buildWaitLine(o)).toBe(
		"wait: nothing of this session's is queued, so there is nothing to wait for.",
	);
});

it("exits landed on the first reading with every queued sha on main", () => {
	const s = scripted(
		{ [A]: "pending", [B]: "pending" },
		{ [A]: "landed", [B]: "pending" },
		{ [A]: "landed", [B]: "landed" },
	);

	const o = waitForLanding(s.read, s.io);

	expect(o).toMatchObject({ kind: "landed", ms: 2 * WAIT_POLL_MS });
	expect(s.reads()).toBe(3);
	if (o.kind !== "landed") throw new Error(o.kind);
	expect(o.reading.lines).toEqual(["read 3"]);
	expect(buildWaitLine(o)).toBe(
		"wait: landed — every queued commit is on main, after 0 min 40 s.",
	);
});

it.each([
	["a dropped stay", "dropped"],
	["a commit that fell off its queue ref", "left"],
] as [string, ShaState][])("exits dropped on %s, naming the sha", (_, gone) => {
	const s = scripted(
		{ [A]: "pending", [B]: "pending" },
		{ [A]: gone, [B]: "landed" },
	);

	const o = waitForLanding(s.read, s.io);

	expect(o).toMatchObject({ kind: "dropped", shas: [A] });
	if (o.kind !== "dropped") throw new Error(o.kind);
	expect(buildWaitLine(o)).toBe(
		`wait: dropped — ${A.slice(0, 9)} left the queue without landing, after 0 min 20 s.`,
	);
});

it("waits on a sha queued after the start, but judges only those queued at it", () => {
	const s = scripted(
		{ [A]: "pending", [B]: "left" },
		{ [A]: "landed", [B]: "pending" },
		{ [A]: "landed", [B]: "left" },
	);

	const o = waitForLanding(s.read, s.io);

	expect(o.kind).toBe("landed");
	expect(s.reads()).toBe(3);
});

it("exits on its bound, under the 15-minute Bash wait, still queued", () => {
	const s = scripted({ [A]: "pending" });

	const o = waitForLanding(s.read, s.io);

	expect(WAIT_BOUND_MS).toBeLessThan(15 * 60_000);
	expect(o.kind).toBe("bound");
	if (o.kind !== "bound") throw new Error(o.kind);
	expect(o.ms).toBeLessThanOrEqual(WAIT_BOUND_MS);
	expect(o.ms + WAIT_POLL_MS).toBeGreaterThan(WAIT_BOUND_MS);
	expect(buildWaitLine(o)).toBe(
		"wait: bound — still queued after 14 min 00 s; run it again to keep waiting.",
	);
});

it("stops on a failed first read with its exit code", () => {
	const s = scripted(NET);
	expect(waitForLanding(s.read, s.io)).toEqual({ kind: "fault", code: 1 });
	expect(s.reads()).toBe(1);
});

it("retries a read that fails on the network mid-wait, and lands on the next good one", () => {
	const s = scripted({ [A]: "pending" }, NET, { [A]: "landed" });

	expect(waitForLanding(s.read, s.io).kind).toBe("landed");
	expect(s.reads()).toBe(3);
});

it("returns a mid-wait network fault still failing at the bound", () => {
	const s = scripted({ [A]: "pending" }, NET);

	expect(waitForLanding(s.read, s.io)).toEqual({ kind: "fault", code: 1 });
	expect(s.reads()).toBeGreaterThan(2);
});

it("stops at once on a mid-wait fault no retry fixes", () => {
	const s = scripted({ [A]: "pending" }, LEDGER, { [A]: "landed" });

	expect(waitForLanding(s.read, s.io)).toEqual({ kind: "fault", code: 1 });
	expect(s.reads()).toBe(2);
});

it.each([
	[
		"landed",
		"dropped",
		"landed",
		"a dropped sha that landed under a later push",
	],
	["queued", "dropped", "pending", "a dropped sha pushed again"],
	[
		"queued",
		"landed",
		"pending",
		"a sha queued again after an earlier stay landed",
	],
	["landed", "testing", "landed", "a landed commit whose batch record lags"],
	["unpushed", "dropped", "dropped", "a dropped sha off every ref"],
	["unpushed", undefined, "left", "a commit off every ref with no stay"],
	[undefined, "testing", "pending", "a stay no ledgered commit names"],
	["queued", undefined, "pending", "a queued commit with no stay"],
	[undefined, undefined, undefined, "nothing read"],
] as const)(
	"reads commit %s with stay %s as %s: %s",
	(commit, ref, want, _why) => {
		expect(shaState(commit, ref)).toBe(want);
	},
);
