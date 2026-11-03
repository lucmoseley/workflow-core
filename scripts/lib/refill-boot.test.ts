// @vitest-environment node
/*
 * Whether a boot restarts the loop (#3878), and the line that says why. Loosen
 * it and a boot undoes a stop, or leaves a loop down that nothing stopped. And when
 * a tick trusts an empty listing (#3880): loosen that and a daemon's fault finishes
 * sessions still running. And which jobs the never-started stop spares (#3983):
 * loosen that and a dead job keeps its admission charge past the boot; tighten it
 * and a killed launch is stopped before it can queue. And whether a spawned loop
 * came to hold the lock (#4083): loosen that and a start that exited reads as a
 * running loop.
 */
import { describe, expect, it } from "vitest";
import {
	awaitLoopHold,
	bootSparedJobs,
	bootVerdictOf,
	isEmptyListingTrusted,
} from "./refill-boot.js";
import { parseState } from "./refill-loop.js";

const START = 1000;
const control = {
	noProgressFrom: START,
	stopRequested: false,
	seats: [],
	scope: { mode: "normal" as const, repos: [], goal: null },
};
const found = {
	control,
	damaged: null,
	stopped: null,
	pid: null,
	self: 7,
};
const stoppedAt = (at: number) => ({
	at,
	reason: "control-damaged",
	detail: "/c is damaged",
});

describe("bootVerdictOf", () => {
	it.each([
		["no stop on record", {}],
		["a pidfile naming this process", { pid: 7 }],
	])("resumes on %s, naming the start it keeps", (_name, over) => {
		expect(bootVerdictOf({ ...found, ...over })).toEqual({
			resume: true,
			line: `boot resume: resumed the loop counting from ${new Date(START).toISOString()}`,
		});
	});

	it.each([
		["a running loop", { pid: 8 }, "already running, pid 8"],
		["a damaged control", { damaged: "it is damaged" }, "it is damaged"],
		["no control", { control: null }, "no start on record"],
		[
			"a stop by command",
			{ control: { ...control, stopRequested: true } },
			"stopped by command",
		],
		[
			"a stop by command the loop recorded, the control since overtaken",
			{ stopped: { at: START, reason: "explicit", detail: "asked" } },
			"stopped by command",
		],
		[
			"a loop that ended itself",
			{ stopped: stoppedAt(START) },
			"the loop ended itself: /c is damaged",
		],
	])("refuses %s, saying so", (_name, over, why) => {
		expect(bootVerdictOf({ ...found, ...over })).toEqual({
			resume: false,
			line: `boot resume: not resumed: ${why}`,
		});
	});
});

const buildLaunch = (over: object) => ({
	root: "/r",
	issues: [1],
	prompt: "/implement 1",
	seat: "/s",
	jobId: "j",
	launchedAt: START,
	finishedAt: null,
	...over,
});
const KILLED = {
	bootKilled: { at: START, sessionId: "s", cwd: "/r", tries: 0 },
};

const buildState = (launches: object[], bootedAt?: number) =>
	parseState({ launches, ...(bootedAt ? { bootedAt } : {}) });

describe("bootSparedJobs (#3983)", () => {
	const spared = (over: object, bootedAt?: number) => [
		...bootSparedJobs(buildState([buildLaunch(over)], bootedAt)),
	];

	it("spares a launch still running in the saved state while a boot is unsettled", () => {
		expect(spared({}, START)).toEqual(["j"]);
	});

	it.each([
		["finished", { finishedAt: START }],
		["with no job", { jobId: null }],
		["already queued", KILLED],
		["being handed off", { handOffTries: 1 }],
		[
			"waiting on the founder",
			{ parked: true, block: { cause: "QUESTION", since: START } },
		],
	])("spares none %s", (_name, over) => {
		expect(spared(over, START)).toEqual([]);
	});

	it("spares nothing with no boot unsettled", () => {
		expect(spared({})).toEqual([]);
	});
});

describe("isEmptyListingTrusted (#3880)", () => {
	const isTrusted = (launches: object[], bootedAt?: number) =>
		isEmptyListingTrusted(buildState(launches, bootedAt));

	it("trusts one on the boot's own tick, whatever the launches", () => {
		expect(isTrusted([buildLaunch({})], START)).toBe(true);
	});

	it("trusts one while killed launches wait and no session should be listed", () => {
		expect(isTrusted([buildLaunch(KILLED)])).toBe(true);
	});

	it("does not once a session it set running should be listed", () => {
		expect(isTrusted([buildLaunch(KILLED), buildLaunch({ jobId: "k" })])).toBe(
			false,
		);
	});

	it("does not with no boot and none killed", () => {
		expect(isTrusted([buildLaunch({})])).toBe(false);
		expect(isTrusted([])).toBe(false);
	});
});

describe("awaitLoopHold (#4083)", () => {
	const Pid = 7;
	const File = "/x/.refill-loop.pid";
	/** One holder and aliveness reading per poll, the last repeating. */
	const polls = (
		holders: (number | null)[],
		alive: boolean[],
		hasHeld = false,
	) => {
		let at = 0;
		let turn = 0;
		const sleeps: number[] = [];
		const reply = awaitLoopHold({
			pid: Pid,
			file: File,
			holder: () =>
				holders[Math.min(turn, holders.length - 1)] as number | null,
			hasHeld: () => hasHeld,
			isAlive: () => alive[Math.min(turn, alive.length - 1)] as boolean,
			now: () => at,
			sleep: (ms: number) => {
				sleeps.push(ms);
				at += ms;
				turn += 1;
			},
		});
		return { reply, sleeps };
	};

	it("is done once the spawned process holds the lock", () => {
		const { reply, sleeps } = polls([null, null, Pid], [true]);
		expect(reply).toBeNull();
		expect(sleeps).toHaveLength(2);
	});

	it("counts a loop that held the lock and has already ended", () => {
		expect(polls([null], [false], true).reply).toBeNull();
	});

	it("says the loop exited where it never held the lock", () => {
		expect(polls([null], [false]).reply).toBe(
			`the loop exited without holding ${File}`,
		);
	});

	it("names another live holder once the spawned process has gone", () => {
		expect(polls([9], [true, false]).reply).toBe(`pid 9 holds ${File}`);
	});

	it("names another live holder where the process outlasts the wait", () => {
		expect(polls([9], [true]).reply).toBe(`pid 9 holds ${File}`);
	});

	it("gives up on a process that outlasts the wait without the lock", () => {
		const { reply } = polls([null], [true]);
		expect(reply).toBe(`the loop did not hold ${File} within 30 s`);
	});
});
