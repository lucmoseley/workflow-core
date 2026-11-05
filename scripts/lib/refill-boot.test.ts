// @vitest-environment node
/*
 * Whether a boot restarts the loop (#3878), and the line that says why. Loosen
 * it and a boot undoes a stop, or leaves a loop down that nothing stopped. And when
 * a tick trusts an empty listing (#3880): loosen that and a daemon's fault finishes
 * sessions still running. And which jobs the never-started stop spares (#3983):
 * loosen that and a dead job keeps its admission charge past the boot; tighten it
 * and a killed launch is stopped before it can queue. And whether a spawned loop
 * came to hold the lock (#4083): loosen that and a start that exited reads as a
 * running loop. And what a same-boot restart queues (#4139): loosen that and a kill
 * of the loop alone queues a live session for a second resume. And what
 * `boot-resume`, `watch` and `run` write around them (#4356): loosen that and a
 * failed boot loses the last loop's death, `watch` restarts over a live loop or
 * logs at every firing, or a run keeps a stop from before it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	awaitLoopHold,
	bootSparedJobs,
	bootVerdictOf,
	holdRun,
	isEmptyListingTrusted,
	runBootResume,
	runWatch,
	settleBootKilled,
	withManagerRestart,
} from "./refill-boot.js";
import { readControlChecked, writeManagerRestart } from "./refill-files.js";
import {
	isSameBoot,
	readState,
	type Transition,
	updateState,
} from "./refill-state.js";
import { loopStateOf } from "./refill-state-testkit";

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

describe("bootVerdictOf, a loop still running (#3971)", () => {
	it("refuses, saying the loop survived", () => {
		expect(bootVerdictOf({ ...found, pid: 8 })).toEqual({
			resume: false,
			line: "boot resume: not resumed: already running, pid 8",
			tellLoop: "boot resume: told the running loop the manager restarted",
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
	loopStateOf({ launches, ...(bootedAt ? { bootedAt } : {}) });

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

const CLEAR = { agents: [], faults: [], seats: ["/s"] };

describe("isEmptyListingTrusted (#3880)", () => {
	const isTrusted = (launches: object[], bootedAt?: number) =>
		isEmptyListingTrusted(buildState(launches, bootedAt), CLEAR);

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

describe("settleBootKilled, a same-boot restart (#4139)", () => {
	const now = START + 60 * 60 * 1000;
	const seen = {
		agents: [{ id: "other", sessionId: "other", state: "working" }],
		now,
		io: {
			jobStateOf: () => null,
			resumeTargetOf: () => ({ sessionId: "s", cwd: "/" }),
			log: () => undefined,
		},
	} as never;
	const settle = (launch: object, registry = CLEAR) =>
		settleBootKilled(
			loopStateOf({
				launches: [buildLaunch({ sessionId: "s", ...launch })],
				bootedAt: now,
				sameBootRestart: true,
			}),
			seen,
			registry,
		);
	const longAgo = { launchedAt: now - 10 * 60 * 1000 };

	it("queues a launch past the grace that neither source names, ending the wait", () => {
		const settled = settle(longAgo);
		expect(settled.launches[0]).toHaveProperty("bootKilled");
		expect(settled).not.toHaveProperty("bootedAt");
	});

	it("spares a live launch the registry names though the listing does not", () => {
		const settled = settle(longAgo, {
			...CLEAR,
			agents: [{ id: "x", sessionId: "s" }],
		} as never);
		expect(settled.launches[0]).not.toHaveProperty("bootKilled");
		expect(settled).not.toHaveProperty("bootedAt");
	});

	it("leaves a launch inside the grace to a later tick, the wait standing", () => {
		const settled = settle({ launchedAt: now - 1000 });
		expect(settled.launches[0]).not.toHaveProperty("bootKilled");
		expect(settled).toMatchObject({ bootedAt: now, sameBootRestart: true });
	});

	it("queues nothing a second time on that later tick", () => {
		const { launches } = settle(longAgo);
		const { launches: again } = settleBootKilled(
			loopStateOf({ launches, bootedAt: now, sameBootRestart: true }),
			seen,
			CLEAR,
		);
		expect(again).toEqual(launches);
	});
});

describe("settleBootKilled, a boot (#3880)", () => {
	const listing = (agents: object[] | null) =>
		({
			agents,
			now: START,
			io: {
				jobStateOf: () => null,
				resumeTargetOf: () => ({ sessionId: "s", cwd: "/" }),
				log: () => undefined,
			},
		}) as never;
	const settle = (agents: object[] | null, bootedAt?: number) =>
		settleBootKilled(
			buildState([buildLaunch({ launchedAt: START - 1 })], bootedAt),
			listing(agents),
			CLEAR,
		);

	it("queues a launch the listing does not name once one reads, ending the wait", () => {
		const settled = settle([], START);
		expect(settled.launches[0]).toHaveProperty("bootKilled");
		expect(settled).not.toHaveProperty("bootedAt");
	});

	it("leaves the launches and the wait as they were where the listing is unread", () => {
		const settled = settle(null, START);
		expect(settled.launches[0]).not.toHaveProperty("bootKilled");
		expect(settled.bootedAt).toBe(START);
	});

	it("queues nothing with no boot unsettled", () => {
		expect(settle([]).launches[0]).not.toHaveProperty("bootKilled");
	});
});

describe("a same-boot restart (#3971)", () => {
	const sameBoot = (launches: object[]) =>
		loopStateOf({ launches, bootedAt: START, sameBootRestart: true });

	const trusted = (registry: object) =>
		isEmptyListingTrusted(sameBoot([buildLaunch({ sessionId: "s" })]), {
			...CLEAR,
			...registry,
		});

	it("trusts an empty listing where the registry shows the launches gone", () => {
		expect(trusted({})).toBe(true);
	});

	it.each([
		["names the launch's job", { agents: [{ id: "j", sessionId: "x" }] }],
		["names the launch's session", { agents: [{ id: "x", sessionId: "s" }] }],
		["has a fault", { faults: ["/s would not read"] }],
		["did not read the launch's seat", { seats: [] }],
	])("trusts none where the registry %s", (_name, registry) => {
		expect(trusted(registry)).toBe(false);
	});

	it("still spares the launches it may have killed until a listing reads", () => {
		expect([...bootSparedJobs(sameBoot([buildLaunch({})]))]).toEqual(["j"]);
	});

	it.each([
		["the boot running as the same", "b", "b", true],
		["another boot as a boot", "a", "b", false],
		["none recorded as a boot", undefined, "b", false],
		["an unread current boot as a boot", null, null, false],
	])("reads %s by whether both ids match", (_name, recorded, current, same) => {
		expect(isSameBoot(recorded, current)).toBe(same);
	});

	it("takes a marker from this boot as the restart", () => {
		expect(
			withManagerRestart(buildState([]), { bootId: "b", at: START }, "b"),
		).toMatchObject({ bootedAt: START, sameBootRestart: true });
	});

	it.each([
		["no marker", null],
		["a marker from another boot", { bootId: "a", at: START }],
	])("leaves the state as it was on %s", (_name, marker) => {
		const state = buildState([]);
		expect(withManagerRestart(state, marker, "b")).toBe(state);
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

/* The control and state through their real readers and writer, in a refill
 * directory of the case's own; the lock, the launch and the unit's restart
 * faked. */
describe("boot-resume, watch and run's hold, on their ports (#4356)", () => {
	let dir = "";
	let before: string | undefined;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "refill-boot-"));
		before = process.env.WFC_REFILL_DIR;
		process.env.WFC_REFILL_DIR = dir;
	});
	afterEach(() => {
		if (before === undefined) delete process.env.WFC_REFILL_DIR;
		else process.env.WFC_REFILL_DIR = before;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const at = (name: string) => path.join(dir, name);
	const Self = 7;
	const writeControl = (extra: object = {}) =>
		fs.writeFileSync(
			at(".refill-loop-control.json"),
			JSON.stringify({ ...control, ...extra }),
		);
	const writeState = (raw: object) =>
		fs.writeFileSync(at(".refill-loop-state.json"), JSON.stringify(raw));
	const readRawState = () =>
		JSON.parse(fs.readFileSync(at(".refill-loop-state.json"), "utf8"));
	const ports = ({
		holder = null as number | null,
		launched = { pid: 42, fetchError: null } as
			| { error: string }
			| { pid: number; fetchError: string | null },
		restartError = null as string | null,
	} = {}) => {
		const noted: string[] = [];
		const calls = { launch: 0, restart: 0 };
		const note = (line: string) => noted.push(line);
		const io = {
			readControl: readControlChecked,
			readState,
			holder: () => holder,
			launchHolder: () => null,
			self: Self,
			note,
			bootId: () => "boot-b",
			now: () => 9000,
			updateState: (t: Transition) => updateState(t, note),
			writeManagerRestart,
			launch: () => {
				calls.launch += 1;
				return launched;
			},
			restartBootUnit: () => {
				calls.restart += 1;
				return { error: restartError };
			},
		};
		return { io, noted, calls };
	};

	describe("watch (#4139)", () => {
		it("does nothing and writes no log line for a live holder, even a paused one", () => {
			writeControl({ paused: { by: "command", at: START } });
			const { io, noted, calls } = ports({ holder: 99 });
			expect(runWatch(io)).toEqual({ code: 0 });
			expect(calls.restart).toBe(0);
			expect(noted).toEqual([]);
			expect(fs.readdirSync(dir)).toEqual([".refill-loop-control.json"]);
		});

		it("restarts the boot unit with no live holder, so boot-resume decides", () => {
			writeControl({ paused: { by: "command", at: START } });
			const { io, calls } = ports();
			expect(runWatch(io)).toEqual({ code: 0 });
			expect(calls.restart).toBe(1);
		});

		it("leaves a damaged control alone, writing no log line", () => {
			fs.writeFileSync(at(".refill-loop-control.json"), "{");
			const { io, noted, calls } = ports();
			expect(runWatch(io)).toEqual({ code: 0 });
			expect(calls.restart).toBe(0);
			expect(noted).toEqual([]);
			expect(fs.readdirSync(dir)).toEqual([".refill-loop-control.json"]);
		});

		it("exits 1 with the restart's error where it fails", () => {
			writeControl();
			const { io } = ports({ restartError: "systemctl … exited 1: denied" });
			expect(runWatch(io)).toEqual({
				code: 1,
				message: "systemctl … exited 1: denied",
			});
		});
	});

	describe("boot-resume (#3878, #4083)", () => {
		it("keeps the last loop's crash on record where the loop dies", () => {
			writeControl();
			writeState({ heldAt: 5 });
			const { io, noted } = ports({
				launched: { error: "the loop exited without holding /p" },
			});
			expect(runBootResume(io)).toBe(1);
			expect(readRawState().heldAt).toBe(5);
			expect(noted).toContain(
				"boot resume: not resumed: the loop exited without holding /p",
			);
			expect(noted.join("\n")).not.toContain("resumed the loop");
		});

		it("leaves heldAt to the new loop where one launches", () => {
			writeControl();
			writeState({ heldAt: 5 });
			const { io, noted } = ports();
			expect(runBootResume(io)).toBe(0);
			expect(readRawState().heldAt).toBeNull();
			expect(noted).toEqual([
				`boot resume: resumed the loop counting from ${new Date(START).toISOString()}, pid 42`,
			]);
		});
	});

	describe("run's hold (#3861)", () => {
		const hold = (acquired: boolean) => {
			const logged: string[] = [];
			const held = holdRun({
				acquire: () => acquired,
				pidFile: "/x/.refill-loop.pid",
				log: (line) => logged.push(line),
				now: () => 9000,
				bootId: () => "boot-b",
				updateState: (t) => updateState(t, (line) => logged.push(line)),
			});
			return { held, logged };
		};
		const Stop = { at: 6, reason: "explicit", detail: "x" };

		it("clears a stop recorded before this run once it holds the pidfile", () => {
			writeState({ stopped: Stop });
			const { held, logged } = hold(true);
			expect(held).toBe(true);
			expect(readRawState()).toMatchObject({ stopped: null, heldAt: 9000 });
			expect(logged).toEqual([]);
		});

		it("keeps the stop, logging why, where another loop holds the pidfile", () => {
			writeState({ stopped: Stop });
			const { held, logged } = hold(false);
			expect(held).toBe(false);
			expect(readRawState().stopped).toEqual(Stop);
			expect(logged).toEqual([
				"another refill loop holds /x/.refill-loop.pid; exiting",
			]);
		});
	});
});
