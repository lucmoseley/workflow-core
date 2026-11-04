// @vitest-environment node
/*
 * The refill loop's state file (#4232): its parse, its one writer, and each
 * named transition as a pure function. Loosen one and a write in a tick
 * overwrites an earlier one, or a field a transition does not own is lost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFILL_STATE_FILE } from "./refill-dir.js";
import { MIN, NOW, record } from "./refill-loop-fixture";
import {
	batchLaunching,
	bootResumed,
	bootResumeFailed,
	killSettled,
	type LoopState,
	lateStopped,
	launchRecorded,
	readState,
	runForgotten,
	runHeld,
	type Transition,
	tickSettled,
	updateState,
} from "./refill-state.js";
import { loopStateOf } from "./refill-state-testkit";

const launch = (over: Record<string, unknown> = {}) =>
	loopStateOf({ launches: [record(over)] }).launches[0];

/* Every field parseState returns, each set off its default. */
const FULL: LoopState = loopStateOf({
	launches: [record()],
	lastTick: { at: NOW, summary: "a tick", skipped: [], idle: null },
	stopped: { at: NOW, reason: "explicit", detail: "d" },
	heldAt: NOW - MIN,
	held: [{ root: "/r", number: 1, why: "w", since: NOW }],
	reviewRunOn: "2026-10-18",
	launchCount: { from: NOW - 60 * MIN, count: 3 },
	handedOff: { from: NOW - 30 * MIN, count: 1 },
	overflowStart: { at: NOW, seat: "/s", planSeats: [], omitted: [] },
	goalProgress: {
		setAt: NOW,
		set: [{ number: 1, repo: null, title: null }],
		takeable: 1,
		running: 0,
		readAt: NOW,
	},
	probeBrokenRoots: ["/r"],
	seatTriedAt: { "/s": NOW },
	bootedAt: NOW - 2 * MIN,
	sameBootRestart: true,
	bootId: "boot-a",
	launching: { at: NOW, batch: [] },
});

const tickOwned = {
	launches: [launch({ jobId: "tick" })],
	lastTick: { at: NOW + 1, summary: "next", skipped: [], idle: null },
	stopped: null,
	held: [],
	launchCount: { from: NOW, count: 0 },
	handedOff: null,
	overflowStart: null,
	goalProgress: null,
	probeBrokenRoots: [],
	seatTriedAt: {},
	bootedAt: undefined,
	sameBootRestart: undefined,
};

/* Each transition with the fields it names; every other must pass through. */
const TRANSITIONS: [string, Transition, (keyof LoopState)[]][] = [
	["runHeld", runHeld(NOW, "boot-b"), ["stopped", "heldAt", "bootId"]],
	["runForgotten", runForgotten(), ["heldAt"]],
	[
		"bootResumed",
		bootResumed("boot-a", NOW),
		["bootedAt", "sameBootRestart", "heldAt"],
	],
	["bootResumeFailed", bootResumeFailed(7), ["heldAt"]],
	["launchRecorded", launchRecorded(launch({ jobId: "new" })), ["launches"]],
	[
		"killSettled",
		killSettled({ launches: [], launchCount: null }, FULL),
		["launches", "launchCount", "launching"],
	],
	[
		"batchLaunching",
		batchLaunching([], FULL, { bootedAt: 1, sameBootRestart: undefined }),
		["launches", "bootedAt", "sameBootRestart", "launching"],
	],
	[
		"batchLaunching, a batch in flight",
		batchLaunching([], FULL, {
			inFlight: {
				launching: { at: NOW, batch: [] },
				launchCount: { from: NOW, count: 9 },
			},
		}),
		["launches", "bootedAt", "sameBootRestart", "launching", "launchCount"],
	],
	[
		"tickSettled",
		tickSettled(tickOwned, FULL),
		[...(Object.keys(tickOwned) as (keyof LoopState)[]), "launching" as const],
	],
	["lateStopped", lateStopped(null, "2026-10-19"), ["stopped", "reviewRunOn"]],
];

describe("every transition", () => {
	it("is tested on a state with every field set", () => {
		for (const v of Object.values(FULL)) expect(v).not.toBeNull();
		expect(Object.keys(FULL)).toEqual(
			expect.arrayContaining(["bootedAt", "sameBootRestart", "launching"]),
		);
	});

	it.each(TRANSITIONS)(
		"%s keeps each field it does not name",
		(_, t, named) => {
			const before = structuredClone(FULL);
			const after = t(FULL);
			expect(FULL).toEqual(before);
			const kept = (Object.keys(FULL) as (keyof LoopState)[]).filter(
				(k) => !named.includes(k),
			);
			expect(kept.length).toBeGreaterThan(0);
			for (const k of kept) expect(after[k]).toEqual(FULL[k]);
		},
	);
});

describe("runHeld and runForgotten (#3861)", () => {
	it("records the hold, this boot and no stop", () => {
		expect(runHeld(NOW, "boot-b")(FULL)).toMatchObject({
			stopped: null,
			heldAt: NOW,
			bootId: "boot-b",
		});
	});

	it("drops the recorded boot where this one will not read", () => {
		expect(runHeld(NOW, null)(FULL)).not.toHaveProperty("bootId");
	});

	it("forgets a hold, and hands back a state holding none unchanged", () => {
		expect(runForgotten()(FULL).heldAt).toBeNull();
		const none = loopStateOf(null);
		expect(runForgotten()(none)).toBe(none);
	});
});

describe("bootResumed and bootResumeFailed (#3880, #3971)", () => {
	it("marks a restart on the boot the loop last held as the manager's", () => {
		expect(bootResumed("boot-a", NOW)(FULL)).toMatchObject({
			bootedAt: NOW,
			sameBootRestart: true,
			heldAt: null,
		});
	});

	it("marks none on another boot, or where this one will not read", () => {
		expect(bootResumed("boot-b", NOW)(FULL)).not.toHaveProperty(
			"sameBootRestart",
		);
		expect(bootResumed(null, NOW)(FULL)).not.toHaveProperty("sameBootRestart");
	});

	it("puts the last hold back on a failed launch", () => {
		const resumed = bootResumed("boot-a", NOW)(FULL);
		expect(bootResumeFailed(FULL.heldAt)(resumed).heldAt).toBe(FULL.heldAt);
	});
});

describe("launchRecorded (#4180)", () => {
	it("replaces the unfinished launch on the same ledger job", () => {
		const stamped = launch({ jobId: "job42", relaunchedAt: NOW });
		const { launches } = launchRecorded(stamped)(FULL);
		expect(launches).toEqual([stamped]);
	});

	it("matches a copy by the job it copied", () => {
		const copy = launch({ jobId: "copy", copiedFrom: "job42" });
		expect(launchRecorded(copy)(FULL).launches).toEqual([copy]);
	});

	it("adds a launch on a job none is unfinished on", () => {
		const finished = { ...FULL, launches: [launch({ finishedAt: NOW })] };
		const again = launch();
		expect(launchRecorded(again)(finished).launches).toEqual([
			...finished.launches,
			again,
		]);
	});
});

describe("the tick's writes", () => {
	const read = loopStateOf({ launches: [record({ jobId: "a" })] });

	it("batchLaunching puts the batch and its count on record", () => {
		const launching = {
			launching: { at: NOW, batch: [] },
			launchCount: { from: NOW, count: 2 },
		};
		expect(
			batchLaunching(read.launches, read, { inFlight: launching })(read),
		).toMatchObject(launching);
	});

	it("batchLaunching without a batch leaves none in flight", () => {
		expect(batchLaunching([], FULL, {})(FULL)).not.toHaveProperty("launching");
	});

	it("tickSettled leaves no batch in flight", () => {
		expect(tickSettled(tickOwned, FULL)(FULL)).not.toHaveProperty("launching");
	});

	it("lateStopped records the stop and the review's date", () => {
		const stop = { at: NOW, reason: "explicit", detail: "" };
		expect(lateStopped(stop, "2026-10-19")(FULL)).toMatchObject({
			stopped: stop,
			reviewRunOn: "2026-10-19",
		});
	});

	it("killSettled writes what the settling left, on the launches it read", () => {
		const settled = [launch({ jobId: "a", relaunchedAt: NOW })];
		const after = killSettled(
			{ launches: settled, launchCount: { from: NOW, count: 1 } },
			read,
		)({ ...read, launching: { at: NOW, batch: [] } });
		expect(after.launches).toEqual(settled);
		expect(after.launchCount).toEqual({ from: NOW, count: 1 });
		expect(after).not.toHaveProperty("launching");
	});

	it("a launchRecorded write mid-tick survives the tick's tickSettled write", () => {
		const midTick = launch({ jobId: "mid" });
		const onDisk = launchRecorded(midTick)(read);
		const judged = launch({ jobId: "a", finishedAt: NOW });
		const after = tickSettled(
			{ ...tickOwned, launches: [judged] },
			read,
		)(onDisk);
		expect(after.launches).toEqual([judged, midTick]);
	});

	it("the tick's word stands on a launch it read, dropped or judged", () => {
		const onDisk = launchRecorded(launch({ jobId: "a", relaunchedAt: NOW }))(
			read,
		);
		expect(
			tickSettled({ ...tickOwned, launches: [] }, read)(onDisk).launches,
		).toEqual([]);
	});
});

describe("parseState's launch rows", () => {
	it("drops a malformed row and logs it", () => {
		const lines: string[] = [];
		const { launches } = loopStateOf(
			{ launches: [record(), { jobId: "x" }, null] },
			(l) => lines.push(l),
		);
		expect(launches).toEqual([record()]);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/dropped a malformed launch row: {"jobId":"x"}/);
	});

	it("reads launches that are no list as none, and logs it", () => {
		const lines: string[] = [];
		expect(
			loopStateOf({ launches: "x" }, (l) => lines.push(l)).launches,
		).toEqual([]);
		expect(lines).toEqual([expect.stringMatching(/launches is not a list/)]);
	});
});

describe("the state file", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-state-"));
		vi.stubEnv("WFC_REFILL_DIR", dir);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const ignore = () => undefined;

	it("applies each write to a fresh read, so a later write keeps an earlier", () => {
		const a = launch({ jobId: "a" });
		updateState(launchRecorded(a), ignore);
		updateState(runHeld(NOW, "boot-a"), ignore);
		expect(readState(ignore)).toMatchObject({
			launches: [a],
			heldAt: NOW,
			bootId: "boot-a",
		});
	});

	it("writes nothing for a transition that changes nothing", () => {
		updateState(runForgotten(), ignore);
		expect(fs.existsSync(path.join(dir, REFILL_STATE_FILE))).toBe(false);
	});

	it("reads a damaged file as the defaults, logging it", () => {
		fs.writeFileSync(path.join(dir, REFILL_STATE_FILE), "{");
		const lines: string[] = [];
		expect(readState((l) => lines.push(l))).toEqual(loopStateOf(null));
		expect(lines[0]).toMatch(/is damaged/);
	});
});
