// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suiteRungMb, WHOLE_SUITE_WORKERS } from "./admission.js";
import { mkScratchDir } from "./git-fixture";
import { chargeMb as launchChargeMb } from "./launch-charge";
import { noop } from "./noop.js";
import { writePsStub } from "./ps-stub";
import { runInProcess } from "./run-in-process.js";
import { tscDenial } from "./tsc-slot";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

const {
	isMarkerStale,
	readMarkers,
	readStartTimeOf,
	PART_PASS_AGE_MS,
	turnOf,
	readLiveRoleMarkers,
	readTestsHeldOnMemory,
	readTestsHeldOnWindows,
	readLiveTypechecks,
	readQueuesClimbMb,
	queuedRunnerPeakMb,
	gateDenies,
	heldSeat,
	SEAT_ENV,
	queueSeat,
	armSeatSignals,
} = require("./suite-queue.js");
const { waitForGate } = require("./gate-wait.js");
const { yieldToWhole } = require("./cpu-yield.js");
const { pidAlive } = require("./arbiter-proc.js");
const { readLiveLanders } = require("./local-tester.js");
const { SUITE_MAX, WHOLE_SUITE_MAX } = require("./admission.js");
const { resolvedFileCount, weighFiles } = require("./suite-bounded.js") as {
	resolvedFileCount: (
		argv: string[],
		readSuite: () => string[] | null,
	) => number | null;
	weighFiles: (files: number | null) => { workers: number; part: boolean };
};

const weighed = (files: number | null) => ({
	resolvedFiles: files,
	wholeSlot: !weighFiles(files).part,
});
const PART = weighed(2);
const SUITE_PEAK_MB = launchChargeMb({ kind: "suite" });
const TSC_PEAK_MB = launchChargeMb({ kind: "tsc" });
const TSC7_PEAK_MB = launchChargeMb({ kind: "tsc", major: 7 });
const TSC5_PEAK_MB = launchChargeMb({ kind: "tsc", major: 5 });
const NAMED_200 = Array.from(
	{ length: 200 },
	(_, i) => `scripts/t${i}.test.ts`,
);
const TOUCHED_200 = { resolvedFiles: 200, wholeSlot: false };

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const noQueue = () => "admitted" as const;

function qdir() {
	const d = mkScratchDir("queue-");
	dirs.push(d);
	return d;
}

const seatWait = (
	wait: object,
	logExit: (...args: unknown[]) => unknown = noop,
) =>
	queueSeat({
		queue: { queueDir: qdir(), alive: () => true },
		join: false,
		turn: () => true,
		logExit,
	}).wait(wait);

const joined = (queueDir: string, pid: number, at: number, join: object = {}) =>
	queueSeat({
		queue: { queueDir, pid, clock: () => at, alive: () => true },
		join,
	});

const seatStamps = (queue: object) => queueSeat({ queue, join: false }).stamps;

async function polled(
	queue: {
		queueDir?: string;
		pid?: number;
		clock?: () => number;
		alive?: (pid: number) => boolean;
		slots?: number;
	} = {},
	wait: object = {},
) {
	const exits: object[] = [];
	await queueSeat({
		queue: { alive: () => true, ...queue },
		join: false,
		logExit: (reason: string, _ms: number, extra: object) =>
			exits.push({ reason, ...extra }),
	}).wait({
		gate: () => null,
		timeoutMs: 0,
		sleepFn: () => Promise.resolve(),
		out: { write: () => true },
		...wait,
	});
	return exits[0];
}

const turnOpen = async (queue: Parameters<typeof polled>[0] = {}) =>
	((await polled(queue)) as { reason: string }).reason === "opened";

const noSeats = () => ({
	count: 0,
	part: 0,
	under: () => false,
	unread: null,
});

describe("isMarkerStale", () => {
	it("is stale when the pid is not alive", () => {
		expect(
			isMarkerStale({ pid: 11 }, { alive: () => false, startTime: () => 0 }),
		).toBe(true);
	});

	it("is live when the pid is alive and carries no start", () => {
		expect(
			isMarkerStale({ pid: 11 }, { alive: () => true, startTime: () => 0 }),
		).toBe(false);
	});

	it("does not judge reuse on a marker with no start at all, even against a live but reused pid (mantahostels#2034)", () => {
		expect(
			isMarkerStale({ pid: 11 }, { alive: () => true, startTime: () => 999 }),
		).toBe(false);
	});

	it("does not judge reuse on start: 0, even where the live pid now has a real start time", () => {
		expect(
			isMarkerStale(
				{ pid: 11, start: 0 },
				{ alive: () => true, startTime: () => 12_345 },
			),
		).toBe(false);
	});

	it("is stale when the pid is alive but its start time no longer matches (reused)", () => {
		expect(
			isMarkerStale(
				{ pid: 11, start: 500 },
				{ alive: () => true, startTime: () => 999 },
			),
		).toBe(true);
	});

	it("is live when the pid is alive but its start time will not read, unlike a reused one whose start no longer matches (#5742)", () => {
		expect(
			isMarkerStale(
				{ pid: 11, start: 500 },
				{ alive: () => true, startTime: () => 0 },
			),
		).toBe(false);
	});

	it("is live when the pid is alive and its start time still matches", () => {
		expect(
			isMarkerStale(
				{ pid: 11, start: 500 },
				{ alive: () => true, startTime: () => 500 },
			),
		).toBe(false);
	});
});

describe("readStartTimeOf", () => {
	it("reads a real process's start time, and 0 for one that is gone", () => {
		expect(readStartTimeOf(process.pid)).toBeGreaterThan(0);
		expect(readStartTimeOf(2 ** 30)).toBe(0);
	});
});

describe("readMarkers", () => {
	type FsStub = Pick<typeof import("node:fs"), "readdirSync" | "readFileSync">;

	const fsImpl = (files: Record<string, string>): FsStub =>
		({
			readdirSync: () => Object.keys(files),
			readFileSync: (file: string) => {
				const name = file.split("/").pop() as string;
				if (!(name in files)) throw new Error("ENOENT");
				return files[name];
			},
		}) as unknown as FsStub;

	it("finds a marker matching the queue prefix and parses it", () => {
		const { markers, error } = readMarkers(
			"/q",
			fsImpl({ "wfc-suite-queue-11.json": '{"pid":11,"at":1}' }),
		);
		expect(error).toBe(null);
		expect(markers).toEqual([
			{ file: "/q/wfc-suite-queue-11.json", record: { pid: 11, at: 1 } },
		]);
	});

	it("ignores a file that does not match the queue-marker prefix", () => {
		const { markers } = readMarkers("/q", fsImpl({ "unrelated.json": "{}" }));
		expect(markers).toEqual([]);
	});

	it("skips a marker that will not parse", () => {
		const { markers } = readMarkers(
			"/q",
			fsImpl({ "wfc-suite-queue-11.json": "not json" }),
		);
		expect(markers).toEqual([]);
	});

	it("skips a marker with a numeric pid and no numeric at", () => {
		const { markers } = readMarkers(
			"/q",
			fsImpl({ "wfc-suite-queue-11.json": '{"pid":11}' }),
		);
		expect(markers).toEqual([]);
	});

	it("skips a marker whose pid is not a number", () => {
		const { markers } = readMarkers(
			"/q",
			fsImpl({ "wfc-suite-queue-x.json": '{"pid":"11","at":1}' }),
		);
		expect(markers).toEqual([]);
	});

	it("reports an unreadable directory as an error, not as an empty list", () => {
		const { markers, error } = readMarkers("/q", {
			readdirSync: () => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			},
			readFileSync: () => "",
		} as unknown as FsStub);
		expect(markers).toEqual([]);
		expect(error).toBeInstanceOf(Error);
	});

	it("reads a directory no waiter has made as the empty queue (#2889)", () => {
		expect(readMarkers(path.join(qdir(), "wfc-suite-queue"))).toEqual({
			markers: [],
			error: null,
		});
	});
});

describe("the queue directory every default reads (#2889)", () => {
	it("is one directory under the temp root, which the root's listing never reaches", async () => {
		const root = qdir();
		vi.stubEnv("TMPDIR", root);
		const lander = queueSeat({ join: { role: "lander" } });
		const file = lander.ticket;
		lander.spawned();
		const swept = queueSeat({ queue: { pid: 2 ** 30 } }).ticket;

		expect(fs.readdirSync(root)).toEqual(["wfc-suite-queue"]);
		expect(path.dirname(file)).toBe(path.join(root, "wfc-suite-queue"));
		expect(
			readLiveRoleMarkers("lander").records.map((m: { pid: number }) => m.pid),
		).toEqual([process.pid]);
		expect(readLiveLanders().live.map((l: { pid: number }) => l.pid)).toEqual([
			process.pid,
		]);
		expect(lander.stamps.admit()).toBe("admitted");
		expect(await turnOpen({ alive: pidAlive })).toBe(true);
		expect(fs.existsSync(swept)).toBe(false);
		const priority = { getPriority: () => 0, setPriority: vi.fn() };
		expect(
			yieldToWhole(
				{ pid: 2 ** 30 },
				{
					pid: 2 ** 30,
					readStat: () => {
						throw new Error("ENOENT");
					},
					priority,
				},
			),
		).toBe(true);

		const stale = queueSeat({ queue: { pid: 2 ** 30 } }).ticket;
		const r = runInProcess(
			path.join(__dirname, "..", "check-stale-suite-queue.js"),
			[],
			{
				env: { ...process.env, CLAUDE_PROJECT_DIR: root, GITHUB_ACTIONS: "" },
			},
		);
		expect(r.stdout + r.stderr).toContain(stale);
	});
});

describe("readLiveRoleMarkers (#2416)", () => {
	it("names the live markers of one role with their charge, sweeping none", () => {
		const queueDir = qdir();
		joined(queueDir, 11, 11, { role: "lander", chargeMb: 600 });
		joined(queueDir, 22, 22, { role: "lander" });
		joined(queueDir, 33, 33);
		expect(
			readLiveRoleMarkers("lander", {
				queueDir,
				alive: (pid: number) => pid !== 22,
			}),
		).toMatchObject({
			records: [{ pid: 11, role: "lander", chargeMb: 600 }],
			unread: null,
		});
		expect(fs.readdirSync(queueDir)).toHaveLength(3);
	});

	it("says the queue would not read rather than reading it empty (#5301)", () => {
		const queueDir = qdir();
		joined(queueDir, 11, 11, { role: "lander" });
		fs.chmodSync(queueDir, 0o000);
		try {
			expect(readLiveRoleMarkers("lander", { queueDir })).toEqual({
				records: [],
				unread: expect.stringMatching(/would not read \(EACCES/),
			});
		} finally {
			fs.chmodSync(queueDir, 0o755);
		}
	});
});

describe("readTestsHeldOnWindows (#4956)", () => {
	it("counts the live waiters the Windows hold is holding, in the suite queue and the type-check slot's", () => {
		const root = qdir();
		const queueDir = path.join(root, "wfc-suite-queue");
		const tscDir = path.join(root, "wfc-tsc-queue");
		joined(queueDir, 11, 11).stamps.onWindowsHeld(true);
		joined(queueDir, 22, 22).stamps.onWindowsHeld(true);
		joined(queueDir, 33, 33).stamps.onMemoryHeld(true);
		joined(tscDir, 44, 44).stamps.onWindowsHeld(true);
		const released = joined(tscDir, 55, 55).stamps;
		released.onWindowsHeld(true);
		released.onWindowsHeld(false);
		expect(
			readTestsHeldOnWindows({
				queueDir,
				alive: (pid: number) => pid !== 22,
			}),
		).toBe(2);
	});

	it("counts none where no queue exists", () => {
		expect(
			readTestsHeldOnWindows({
				queueDir: path.join(qdir(), "wfc-suite-queue"),
			}),
		).toBe(0);
	});
});

describe("readTestsHeldOnMemory (#5555)", () => {
	it("charges each live, unadmitted waiter the memory rung holds, in the suite queue and the type-check slot's, its launch's peak", () => {
		const root = qdir();
		const queueDir = path.join(root, "wfc-suite-queue");
		const tscDir = path.join(root, "wfc-tsc-queue");
		const rung = joined(queueDir, 11, 11, { chargeMb: 900 }).stamps;
		rung.onMemoryHeld(true);
		rung.onMemoryRung(3350);
		joined(queueDir, 22, 22).stamps.onMemoryHeld(true);
		joined(queueDir, 33, 33).stamps.onWindowsHeld(true);
		joined(queueDir, 44, 44, { role: "gate" }).stamps.onMemoryHeld(true);
		const admitted = joined(queueDir, 55, 55);
		admitted.stamps.onMemoryHeld(true);
		admitted.spawned();
		joined(tscDir, 66, 66).stamps.onMemoryHeld(true);
		const released = joined(tscDir, 77, 77).stamps;
		released.onMemoryHeld(true);
		released.onMemoryHeld(false);
		expect(
			readTestsHeldOnMemory({
				queueDir,
				alive: (pid: number) => pid !== 22,
			}),
		).toEqual([
			{ pid: 11, chargeMb: 900, rungMb: 3350 },
			{ pid: 66, chargeMb: launchChargeMb({ kind: "tsc" }) },
		]);
	});

	it("holds none where no queue exists", () => {
		expect(
			readTestsHeldOnMemory({
				queueDir: path.join(qdir(), "wfc-suite-queue"),
			}),
		).toEqual([]);
	});

	it("holds none where the queue will not read, its waiters failing open", () => {
		const queueDir = path.join(qdir(), "wfc-suite-queue");
		joined(queueDir, 11, 11).stamps.onMemoryHeld(true);
		const refusing = {
			...fs,
			readdirSync: (() => {
				throw new Error("EACCES");
			}) as unknown as typeof fs.readdirSync,
		};
		expect(
			readTestsHeldOnMemory({
				queueDir,
				queueFs: refusing,
				alive: () => true,
			}),
		).toEqual([]);
	});
});

describe("readLiveTypechecks (#5703)", () => {
	it("reads each live type-check, queued or running, at its launch's peak, leaving a memory-held one to the held-run reserve", () => {
		const tscDir = path.join(qdir(), "wfc-tsc-queue");
		joined(tscDir, 11, 11, { chargeMb: 2045 });
		joined(tscDir, 22, 22).spawned();
		joined(tscDir, 33, 33).stamps.onMemoryHeld(true);
		joined(tscDir, 44, 44);
		expect(
			readLiveTypechecks({
				queueDir: tscDir,
				alive: (pid: number) => pid !== 44,
				unreadMb: () => 0,
			}),
		).toEqual({
			live: [
				{ pid: 11, chargeMb: 2045, spawned: false },
				{
					pid: 22,
					chargeMb: launchChargeMb({ kind: "tsc" }),
					spawned: true,
				},
			],
			unread: null,
		});
	});

	it("reads none where no queue exists", () => {
		expect(
			readLiveTypechecks({
				queueDir: path.join(qdir(), "wfc-tsc-queue"),
				unreadMb: () => 0,
			}),
		).toEqual({ live: [], unread: null });
	});

	it("holds the fallback charge, and says why, where the queue will not read", () => {
		const refusing = {
			...fs,
			readdirSync: (() => {
				throw new Error("EACCES");
			}) as unknown as typeof fs.readdirSync,
		};
		const { live, unread } = readLiveTypechecks({
			queueDir: path.join(qdir(), "wfc-tsc-queue"),
			queueFs: refusing,
			unreadMb: () => 1497,
		});
		expect(live).toEqual([]);
		expect(unread).toEqual({
			why: expect.stringMatching(
				/type-check queue .* would not read \(EACCES\)/,
			),
			chargeMb: 1497,
		});
	});
});

describe("heldSeat, a mutation loop's one seat (#2918)", () => {
	const parentOf = (pid: number) => (pid > 10 ? pid - 10 : 1);
	const seat = (weight = PART, spawned = true) => {
		const queueDir = qdir();
		const held = joined(queueDir, 20, 20, { weight });
		if (spawned) held.spawned();
		return held.ticket;
	};
	const read = (file: string, extra: object = {}) =>
		heldSeat({
			env: { [SEAT_ENV]: file },
			pid: 40,
			alive: () => true,
			parentOf,
			...extra,
		});

	it("names the seat a run's ancestor holds", () => {
		const file = seat();
		expect(read(file)).toBe(file);
	});

	it.each([
		["no seat is named", () => ({ env: {} })],
		[
			"the seat's holder is no ancestor, the variable leaked",
			() => ({ pid: 5 }),
		],
		["the seat's holder is dead", () => ({ alive: () => false })],
	])("holds no seat where %s", (_why, extra) => {
		expect(read(seat(), extra())).toBeNull();
	});

	it.each([
		["a whole marker", () => seat({ resolvedFiles: null, wholeSlot: true })],
		["an unspawned one", () => seat(PART, false)],
		[
			"a marker that is gone",
			() => path.join(qdir(), "wfc-suite-queue-20.json"),
		],
	])("holds no seat on %s", (_what, file) => {
		expect(read(file())).toBeNull();
	});

	it("walks the real process tree", () => {
		const queueDir = qdir();
		const held = queueSeat({
			queue: { queueDir, pid: process.ppid },
			join: { weight: PART },
		});
		held.spawned();
		const file = held.ticket;
		expect(heldSeat({ env: { [SEAT_ENV]: file } })).toBe(file);
	});
});

describe("turnOf, the turn's rule (#4260)", () => {
	interface Ahead {
		at: number;
		part?: boolean;
		kind?: "named" | "touched";
		spawned?: boolean;
		memoryHeld?: boolean;
		restHeld?: boolean;
		windowsHeld?: boolean;
	}
	const turn = (
		{
			waiter = "whole" as "whole" | "part" | "named" | "tsc",
			ahead = [] as Ahead[],
			admissionOpen = false,
			peerClimbHeld = false,
			slots = WHOLE_SUITE_MAX,
			now = 1000,
		} = {},
		options?: { partPass?: boolean; namedLane?: boolean },
	) =>
		turnOf(
			{ waiter, ahead, admissionOpen, peerClimbHeld, slots, now },
			options,
		);
	const reasons = (...args: Parameters<typeof turn>) => turn(...args).reasons;
	const wholeAhead = { at: 0 };
	const partAhead = { at: 0, part: true };

	it("opens where nobody waits ahead", () => {
		expect(turn()).toEqual({ reasons: [] });
		expect("passed" in turn()).toBe(false);
		expect(turn({ waiter: "tsc" })).toEqual({ reasons: [] });
	});

	describe("a whole suite", () => {
		it("waits behind a waiter ahead of it that has not spawned, at any slot count", () => {
			expect(reasons({ ahead: [wholeAhead] })).toEqual(["fifo-whole"]);
			expect(reasons({ ahead: [partAhead] })).toEqual(["fifo-whole"]);
			expect(reasons({ ahead: [wholeAhead], slots: 2 })).toEqual([
				"fifo-whole",
			]);
		});

		it("waits while a whole suite ahead of it runs, the slots full", () => {
			const running = { ...wholeAhead, spawned: true };
			expect(reasons({ ahead: [running] })).toEqual(["fifo-whole"]);
			expect(reasons({ ahead: [running], slots: 2 })).toEqual([]);
		});

		it("takes no slot from part-suites running ahead of it (#2558)", () => {
			const ahead = Array.from({ length: SUITE_MAX }, (_, i) => ({
				at: i,
				part: true,
				spawned: true,
			}));
			expect(reasons({ ahead })).toEqual([]);
		});

		it("never passes an older part-suite the memory rung holds (#3058)", () => {
			expect(reasons({ ahead: [{ ...partAhead, memoryHeld: true }] })).toEqual([
				"fifo-whole",
			]);
		});
	});

	describe("a part-suite, which takes no slot (#2558)", () => {
		it("runs past an older whole suite the gate still holds unspawned (#2578)", () => {
			expect(turn({ waiter: "part", ahead: [wholeAhead] })).toEqual({
				reasons: [],
				passed: 0,
			});
		});

		it("runs beside whole suites holding every slot", () => {
			const ahead = Array.from({ length: WHOLE_SUITE_MAX + 1 }, (_, i) => ({
				at: i,
				spawned: i < WHOLE_SUITE_MAX,
			}));
			expect(turn({ waiter: "part", ahead })).toEqual({
				reasons: [],
				passed: 0,
			});
		});

		it("waits for a part-suite ahead of it to spawn", () => {
			expect(reasons({ waiter: "part", ahead: [partAhead] })).toEqual([
				"fifo-part",
			]);
			expect(
				reasons({ waiter: "part", ahead: [{ ...partAhead, spawned: true }] }),
			).toEqual([]);
		});

		describe("passing an older part-suite the memory rung holds (#3058)", () => {
			const held = { ...partAhead, memoryHeld: true };

			it("passes it until its wait reaches the age bound", () => {
				expect(
					turn({ waiter: "part", ahead: [held], now: PART_PASS_AGE_MS - 1 }),
				).toEqual({ reasons: [], passed: 1 });
				expect(
					reasons({ waiter: "part", ahead: [held], now: PART_PASS_AGE_MS }),
				).toEqual(["fifo-part"]);
			});

			it("never passes one held only on its turn", () => {
				expect(reasons({ waiter: "part", ahead: [partAhead] })).toEqual([
					"fifo-part",
				]);
			});

			it("counts the memory-held waiters it passed, never a spawned one (#3115)", () => {
				const ahead = [held, { at: 500, part: true, spawned: true }];
				expect(turn({ waiter: "part", ahead, now: 2000 }).passed).toBe(1);
			});

			it("passes none with the switch off", () => {
				expect(
					reasons({ waiter: "part", ahead: [held] }, { partPass: false }),
				).toEqual(["fifo-part"]);
			});
		});

		describe("passing an older part-suite the memory rung holds at rest (#4783)", () => {
			const atRest = { ...partAhead, memoryHeld: true, restHeld: true };

			it("passes it past the age bound", () => {
				expect(
					turn({ waiter: "part", ahead: [atRest], now: 5 * PART_PASS_AGE_MS }),
				).toEqual({ reasons: [], passed: 1 });
			});

			it("stops passing it once a run that ends could let it in", () => {
				expect(
					reasons({
						waiter: "part",
						ahead: [{ ...partAhead, memoryHeld: true }],
						now: 5 * PART_PASS_AGE_MS,
					}),
				).toEqual(["fifo-part"]);
			});

			it("passes none with the switch off, and never for a whole suite", () => {
				expect(
					reasons({ waiter: "part", ahead: [atRest] }, { partPass: false }),
				).toEqual(["fifo-part"]);
				expect(reasons({ ahead: [atRest] })).toEqual(["fifo-whole"]);
			});
		});

		describe("passing an older part-suite the Windows-memory hold keeps out (#4782)", () => {
			const held = { ...partAhead, windowsHeld: true };

			it("passes it at any age, the memory rung's bound not applying", () => {
				expect(
					turn({ waiter: "part", ahead: [held], now: 5 * PART_PASS_AGE_MS }),
				).toEqual({ reasons: [], passed: 1 });
			});

			it("passes none with the switch off, and never for a whole suite", () => {
				expect(
					reasons({ waiter: "part", ahead: [held] }, { partPass: false }),
				).toEqual(["fifo-part"]);
				expect(reasons({ ahead: [held] })).toEqual(["fifo-whole"]);
			});
		});
	});

	describe("a named part-suite, in a lane of its own (#5367)", () => {
		const named = { ...partAhead, kind: "named" as const };
		const touched = { ...partAhead, kind: "touched" as const };

		it("passes every older part-suite, named or touched, held or not, counting them", () => {
			expect(
				turn({
					waiter: "named",
					ahead: [named, touched, wholeAhead],
					now: PART_PASS_AGE_MS - 1,
				}),
			).toEqual({ reasons: [], passed: 2 });
			expect(
				turn({
					waiter: "named",
					ahead: [{ ...named, at: 0 }],
					now: 5 * PART_PASS_AGE_MS,
				}),
			).toEqual({ reasons: [], passed: 1 });
		});

		it("never counts a spawned part-suite as passed", () => {
			expect(
				turn({ waiter: "named", ahead: [{ ...touched, spawned: true }] }),
			).toEqual({ reasons: [], passed: 0 });
		});

		it("closes on an older touched waiter's first claim from PART_PASS_AGE_MS, and not before", () => {
			expect(
				reasons({ waiter: "named", ahead: [touched], now: PART_PASS_AGE_MS }),
			).toEqual(["touched-claim"]);
			expect(
				reasons({
					waiter: "named",
					ahead: [touched],
					now: PART_PASS_AGE_MS - 1,
				}),
			).toEqual([]);
		});

		it("gives first claim to a part marker with no kind, one joined before markers carried it", () => {
			expect(
				reasons({ waiter: "named", ahead: [partAhead], now: PART_PASS_AGE_MS }),
			).toEqual(["touched-claim"]);
		});

		it("gives no claim to an old named waiter, nor to a spawned touched one", () => {
			expect(
				reasons({
					waiter: "named",
					ahead: [named, { ...touched, spawned: true }],
					now: 5 * PART_PASS_AGE_MS,
				}),
			).toEqual([]);
		});

		it("still closes on an admission open and on a peer the climb holds", () => {
			expect(turn({ waiter: "named", admissionOpen: true })).toEqual({
				reasons: ["admitted"],
			});
			expect(turn({ waiter: "named", peerClimbHeld: true })).toEqual({
				reasons: ["peer-climb"],
			});
			expect(
				reasons({
					waiter: "named",
					ahead: [touched],
					admissionOpen: true,
					peerClimbHeld: true,
					now: PART_PASS_AGE_MS,
				}),
			).toEqual(["touched-claim", "admitted", "peer-climb"]);
		});

		it("takes a touched part-suite's rules with the lane off", () => {
			expect(
				reasons({ waiter: "named", ahead: [named] }, { namedLane: false }),
			).toEqual(["fifo-part"]);
		});

		it("leaves a touched part-suite's rules as they were, behind a younger named one's lane", () => {
			expect(reasons({ waiter: "part", ahead: [named] })).toEqual([
				"fifo-part",
			]);
			expect(
				turn({
					waiter: "part",
					ahead: [{ ...named, memoryHeld: true }],
					now: PART_PASS_AGE_MS - 1,
				}),
			).toEqual({ reasons: [], passed: 1 });
			expect(
				turn({
					waiter: "part",
					ahead: [{ ...touched, windowsHeld: true }],
					now: 5 * PART_PASS_AGE_MS,
				}),
			).toEqual({ reasons: [], passed: 1 });
			expect(
				reasons({
					waiter: "part",
					ahead: [{ ...touched, memoryHeld: true }],
					now: PART_PASS_AGE_MS,
				}),
			).toEqual(["fifo-part"]);
		});
	});

	it("holds a `tsc` behind its own queue's older waiter, named as its own limb (#3163)", () => {
		expect(reasons({ waiter: "tsc", ahead: [wholeAhead] })).toEqual([
			"tsc-fifo",
		]);
	});

	it("closes every class while another launch is admitted unspawned, after its fifo", () => {
		for (const waiter of ["whole", "part", "tsc"] as const)
			expect(turn({ waiter, admissionOpen: true })).toEqual({
				reasons: ["admitted"],
			});
		expect(
			reasons({ waiter: "part", ahead: [partAhead], admissionOpen: true }),
		).toEqual(["fifo-part", "admitted"]);
	});
});

describe("readTurn, off the queue's markers (mantahostels#2024)", () => {
	const deadOnly =
		(...dead: number[]) =>
		(pid: number) =>
			!dead.includes(pid);

	it("says no while an older waiter is still alive, and yes to the older", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		joined(queueDir, 22, 200);
		expect(await turnOpen({ queueDir, pid: 22 })).toBe(false);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(true);
	});

	it("holds a whole suite while a queued one ahead of it runs, and opens once it leaves", async () => {
		const queueDir = qdir();
		const ahead = joined(queueDir, 11, 100);
		joined(queueDir, 22, 200);
		ahead.spawned();
		expect(await turnOpen({ queueDir, pid: 22 })).toBe(false);
		ahead.leave();
		expect(await turnOpen({ queueDir, pid: 22 })).toBe(true);
	});

	it("reads the slot count it is given", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100).spawned();
		joined(queueDir, 22, 200);
		expect(await turnOpen({ queueDir, pid: 22 })).toBe(false);
		expect(await turnOpen({ queueDir, pid: 22, slots: 2 })).toBe(true);
	});

	it.each([
		["a part-suite behind an admitted whole suite", 11, 99],
		["a whole suite ahead of an admitted part-suite", 99, 11],
	])("holds %s until it spawns", async (_, launcher, waiter) => {
		const queueDir = qdir();
		const seats = new Map(
			[11, 99].map((pid) => [
				pid,
				joined(queueDir, pid, pid, pid === 99 ? { weight: PART } : {}),
			]),
		);
		const seat = seats.get(launcher);
		expect(seat?.stamps.admit()).toBe("admitted");
		expect(await turnOpen({ queueDir, pid: waiter })).toBe(false);
		seat?.spawned();
		expect(await turnOpen({ queueDir, pid: waiter })).toBe(true);
	});

	describe("the memory-held stamp an older part-suite's seat writes (#3058)", () => {
		const twoPartWaiters = (queueDir: string) => {
			const older = joined(queueDir, 11, 0, { weight: PART });
			joined(queueDir, 99, 1000, { weight: PART });
			return older;
		};

		it("lets a younger part-suite pass it, its exit line counting the pass (#3115)", async () => {
			const queueDir = qdir();
			twoPartWaiters(queueDir).stamps.onMemoryHeld(true);
			expect(await polled({ queueDir, pid: 99, clock: () => 2000 })).toEqual({
				reason: "opened",
				passed: 1,
			});
		});

		it("carries 0 where the turn opened passing none, and nothing for a whole suite", async () => {
			const queueDir = qdir();
			joined(queueDir, 99, 0, { weight: PART });
			expect(await polled({ queueDir, pid: 99 })).toEqual({
				reason: "opened",
				passed: 0,
			});
			const wholeDir = qdir();
			joined(wholeDir, 33, 1000);
			expect(await polled({ queueDir: wholeDir, pid: 33 })).toEqual({
				reason: "opened",
			});
		});

		it("carries nothing on an exit other than opened", async () => {
			const queueDir = qdir();
			twoPartWaiters(queueDir).stamps.onMemoryHeld(true);
			const gates = [null, { limb: "memory" as const }];
			expect(
				await polled(
					{ queueDir, pid: 99, clock: () => 2000 },
					{ gate: () => gates.shift() ?? null, admit: () => "behind" },
				),
			).toEqual({ reason: "refused", limb: "memory" });
		});

		it("drops the stamp once the rung frees it, closing the turn again", async () => {
			const queueDir = qdir();
			const older = twoPartWaiters(queueDir);
			const readMemoryHeld = () =>
				JSON.parse(fs.readFileSync(older.ticket, "utf8")).memoryHeld;
			older.stamps.onMemoryHeld(true);
			expect(readMemoryHeld()).toBe(true);
			older.stamps.onMemoryHeld(false);
			expect(readMemoryHeld()).toBeUndefined();
			expect(await turnOpen({ queueDir, pid: 99, clock: () => 2000 })).toBe(
				false,
			);
		});
	});

	describe("the Windows-held stamp an older part-suite's wait writes (#4782)", () => {
		const late = 5 * PART_PASS_AGE_MS;
		const HeadFiles = 6;
		const BehindFiles = 1;
		const windowsHold = () => ({ limb: "windows" as const, mb: 999 });
		const headHeldOn = async (headGate: () => object | null) => {
			const queueDir = qdir();
			const head = joined(queueDir, 11, 0, { weight: weighed(HeadFiles) });
			joined(queueDir, 99, 1000, { weight: weighed(BehindFiles) });
			let t = 0;
			let behind: object | undefined;
			const outcome = await head.wait({
				gate: headGate as never,
				monoClock: () => t,
				timeoutMs: late,
				sleepFn: async () => {
					behind = await polled(
						{ queueDir, pid: 99, clock: () => late },
						{ gate: () => null },
					);
					t = late;
				},
				out: { write: () => true },
			});
			return { outcome, behind };
		};

		it("admits a part-suite its gate opens for past a head the hold keeps out, past the memory age bound", async () => {
			expect((await headHeldOn(windowsHold)).behind).toEqual({
				reason: "opened",
				passed: 1,
			});
		});

		it("holds it behind a head the memory rung keeps out that long", async () => {
			const { behind } = await headHeldOn(() => ({
				limb: "memory",
				mb: 1000,
				rungMb: 2000,
			}));
			expect(behind).toMatchObject({ reason: "refused" });
		});

		it("drops the stamp once the hold frees it", () => {
			const queueDir = qdir();
			const head = joined(queueDir, 11, 0, { weight: PART });
			const read = () =>
				JSON.parse(fs.readFileSync(head.ticket, "utf8")).windowsHeld;
			head.stamps.onWindowsHeld(true);
			expect(read()).toBe(true);
			head.stamps.onWindowsHeld(false);
			expect(read()).toBeUndefined();
		});
	});

	describe("the rest stamp an older part-suite's wait writes (#4783)", () => {
		const late = 5 * PART_PASS_AGE_MS;
		const behindHeadHeldOn = async (denial: object) => {
			const queueDir = qdir();
			const head = joined(queueDir, 11, 0, { weight: PART });
			joined(queueDir, 99, 1000, { weight: PART });
			let t = 0;
			let behind: object | undefined;
			await head.wait({
				gate: () => ({ limb: "memory", mb: 1000, rungMb: 2550, ...denial }),
				monoClock: () => t,
				timeoutMs: late,
				sleepFn: async () => {
					behind = await polled({ queueDir, pid: 99, clock: () => late });
					t = late;
				},
				out: { write: () => true },
			});
			return behind;
		};

		it("admits a part-suite that fits past a head held with nothing running", async () => {
			expect(await behindHeadHeldOn({ busy: 0 })).toEqual({
				reason: "opened",
				passed: 1,
			});
		});

		it.each([
			["vitest workers running", { busy: 2 }],
			["a climb charged", { busy: 0, climbMb: 400 }],
			["`ps` unread", {}],
		])("holds it behind a head held with %s", async (_what, denial) => {
			expect(await behindHeadHeldOn(denial)).toMatchObject({
				reason: "refused",
			});
		});

		it("drops the stamp once the rest ends", () => {
			const queueDir = qdir();
			const head = joined(queueDir, 11, 0, { weight: PART });
			const read = () =>
				JSON.parse(fs.readFileSync(head.ticket, "utf8")).restHeld;
			head.stamps.onRestHeld(true);
			expect(read()).toBe(true);
			head.stamps.onRestHeld(false);
			expect(read()).toBeUndefined();
		});
	});

	describe("a part-suite by the weight its seat joined with (#2931)", () => {
		const besideRunning = (weight?: object) => {
			const queueDir = qdir();
			joined(queueDir, 11, 11).spawned();
			joined(queueDir, 99, 99, weight ? { weight } : {});
			return turnOpen({ queueDir, pid: 99 });
		};

		it.each([
			[2, "comes", true],
			[WHOLE_SLOT_BOUND - 1, "comes", true],
			[WHOLE_SLOT_BOUND, "waits", false],
			[485, "waits", false],
		])(
			"beside a running whole suite, a run resolving to %i files' turn %s",
			async (n, _verb, open) => {
				expect(await besideRunning(weighed(n))).toBe(open);
			},
		);

		it("seats a `--changed` run resolving below the bound beside a held slot", async () => {
			expect(await besideRunning(weighed(40))).toBe(true);
		});

		it("never seats a full run of a 50-file repo on the slot", async () => {
			const suite = Array.from({ length: 50 }, (_, i) => `t${i}.test.ts`);
			const weight = weighed(resolvedFileCount([], () => suite));
			expect(weight).toEqual({ resolvedFiles: 50, wholeSlot: false });
			expect(await besideRunning(weight)).toBe(true);
		});

		it("seats a touched run beside a held slot, a 200-file named run among them (#2935)", async () => {
			expect(await besideRunning(TOUCHED_200)).toBe(true);
		});

		it("joins a waiter with no carried weight whole", async () => {
			expect(await besideRunning()).toBe(false);
		});
	});

	describe("a named part-suite's lane, by the kind its marker carries (#5367)", () => {
		const kindsOf = (queueDir: string) =>
			Object.fromEntries(
				readMarkers(queueDir).markers.map(
					(m: { record: { pid: number; kind?: string } }) => [
						m.record.pid,
						m.record.kind,
					],
				),
			);

		it("writes the kind on a part-suite's marker alone", () => {
			const queueDir = qdir();
			joined(queueDir, 11, 0, { weight: PART, kind: "named" });
			joined(queueDir, 22, 0, { weight: weighed(485), kind: "named" });
			expect(kindsOf(queueDir)).toEqual({ 11: "named", 22: undefined });
		});

		const behindTouched = async (at: number) => {
			const queueDir = qdir();
			const touched = joined(queueDir, 11, 0, {
				weight: PART,
				kind: "touched",
			});
			const named = joined(queueDir, 99, at, { weight: PART, kind: "named" });
			const lines: string[] = [];
			let polls = 0;
			await named.wait({
				gate: () => null,
				traceLimbs: true,
				label: "q",
				waiting: "waiting",
				sleepFn: () => {
					polls++;
					touched.spawned();
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
			});
			return { lines, polls };
		};

		it("passes a younger touched waiter on its first poll", async () => {
			expect((await behindTouched(PART_PASS_AGE_MS - 1)).polls).toBe(0);
		});

		it("names the touched waiter whose first claim holds it, until it spawns", async () => {
			const { lines, polls } = await behindTouched(PART_PASS_AGE_MS);
			expect(polls).toBe(1);
			expect(lines[1]).toBe(
				"q: after 0s, held on an older touched run's first claim on memory, PID 11\n",
			);
		});
	});

	it("steps over a dead waiter's marker, and sweeps it", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		joined(queueDir, 22, 200);
		expect(await turnOpen({ queueDir, pid: 22, alive: deadOnly(11) })).toBe(
			true,
		);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-22.json"]);
	});

	it("breaks a tied timestamp on pid, so both waiters agree", async () => {
		const queueDir = qdir();
		joined(queueDir, 100, 100);
		joined(queueDir, 9, 100);
		expect(await turnOpen({ queueDir, pid: 9 })).toBe(true);
		expect(await turnOpen({ queueDir, pid: 100 })).toBe(false);
	});

	it("ignores a marker that is not JSON rather than throwing", async () => {
		const queueDir = qdir();
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-99.json"),
			"not json",
		);
		joined(queueDir, 11, 100);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(true);
	});

	it("fails open when the queue directory cannot be read", async () => {
		expect(await turnOpen({ queueDir: "/no/such/queue/dir", pid: 11 })).toBe(
			true,
		);
	});

	it("leaving removes only this waiter's marker", () => {
		const queueDir = qdir();
		const mine = joined(queueDir, 11, 100);
		joined(queueDir, 22, 200);
		mine.leave();
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-22.json"]);
	});

	it("does not sweep its own marker even if the liveness probe says dead", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		expect(await turnOpen({ queueDir, pid: 11, alive: () => false })).toBe(
			true,
		);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-11.json"]);
	});

	it("treats a reused pid as stale, even though it is alive", async () => {
		const queueDir = qdir();
		const mine = joined(queueDir, 11, 100);
		fs.writeFileSync(
			path.join(queueDir, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 50, start: 999_999_999 }),
		);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(true);
		expect(fs.readdirSync(queueDir)).toEqual([path.basename(mine.ticket)]);
	});

	describe("a joined type-check's files (#5640)", () => {
		const join = (queueDir: string, pid: number, start: number, run: number) =>
			fs.writeFileSync(
				path.join(queueDir, `wfc-tsc-join-${pid}.json`),
				JSON.stringify({
					pid,
					start,
					at: 1,
					session: null,
					run: { pid: run, start: 0 },
				}),
			);
		const capture = (queueDir: string, pid: number, start = 0) => {
			for (const ext of ["out", "err", "result.json"])
				fs.writeFileSync(
					path.join(queueDir, `wfc-tsc-run-${pid}-${start}.${ext}`),
					"",
				);
		};

		it("reaps a dead joiner's marker and a dead runner's capture no live joiner names", async () => {
			const queueDir = qdir();
			const mine = joined(queueDir, 11, 100);
			join(queueDir, 30, 0, 40);
			capture(queueDir, 40);
			join(queueDir, 31, 0, 41);
			capture(queueDir, 41);
			capture(queueDir, 42);
			await turnOpen({ queueDir, pid: 11, alive: deadOnly(30, 40, 41) });
			expect(fs.readdirSync(queueDir).sort()).toEqual(
				[
					path.basename(mine.ticket),
					"wfc-tsc-join-31.json",
					"wfc-tsc-run-41-0.err",
					"wfc-tsc-run-41-0.out",
					"wfc-tsc-run-41-0.result.json",
					"wfc-tsc-run-42-0.err",
					"wfc-tsc-run-42-0.out",
					"wfc-tsc-run-42-0.result.json",
				].sort(),
			);
		});

		it("reaps them on a reused pid, alive but started anew", async () => {
			const queueDir = qdir();
			const mine = joined(queueDir, 11, 100);
			join(queueDir, process.pid, 999_999_999, 40);
			capture(queueDir, process.pid, 999_999_999);
			await turnOpen({
				queueDir,
				pid: 11,
				alive: (pid) => pid === process.pid || pid === 11,
			});
			expect(fs.readdirSync(queueDir)).toEqual([path.basename(mine.ticket)]);
		});
	});

	it("falls back to liveness alone when a marker carries no start time", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-12.json"),
			JSON.stringify({ pid: 12, at: 50 }),
		);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(false);
		expect(fs.readdirSync(queueDir)).toHaveLength(2);
	});

	it("falls back to liveness when a marker records a start time of 0", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		fs.writeFileSync(
			path.join(queueDir, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 50, start: 0 }),
		);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(false);
		expect(fs.readdirSync(queueDir)).toHaveLength(2);
	});
});

describe("two launches whose turns came true on one poll (#2622)", () => {
	type Seat = ReturnType<typeof queueSeat>;
	const alive = () => true;
	const admitted = (seat: Seat) =>
		JSON.parse(fs.readFileSync(seat.ticket, "utf8")).admitted === true;
	const stamp = (seat: Seat) => {
		const record = JSON.parse(fs.readFileSync(seat.ticket, "utf8"));
		fs.writeFileSync(
			seat.ticket,
			JSON.stringify({ ...record, admitted: true }),
		);
	};

	const pair = (hooked?: number, between?: () => void, join22: object = {}) => {
		const queueDir = qdir();
		const onReread = {
			...fs,
			readdirSync: (dir: string) => {
				between?.();
				return fs.readdirSync(dir);
			},
		};
		const seat = (pid: number, join: object = {}) =>
			queueSeat({
				queue: {
					queueDir,
					pid,
					clock: () => pid,
					alive,
					...(pid === hooked ? { queueFs: onReread } : {}),
				},
				join,
			});
		return { 11: seat(11), 22: seat(22, join22) };
	};

	it("yields where the other stamped and re-read in between, so one launches", () => {
		let other = "";
		const seats = pair(11, () => {
			other ||= seats[22].stamps.admit();
		});
		const mine = seats[11].stamps.admit();
		expect([mine, other]).toEqual(["admitted", "behind"]);
		expect([admitted(seats[11]), admitted(seats[22])]).toEqual([true, false]);
	});

	it.each([
		["the older", 11, 22, "ahead"],
		["the younger", 22, 11, "behind"],
	] as const)(
		"yields as %s where both stamped before either re-read",
		(_, pid, rival, how) => {
			const seats = pair(pid, () => stamp(seats[rival]));
			expect(seats[pid].stamps.admit()).toBe(how);
			expect(admitted(seats[pid])).toBe(false);
			expect(seats[rival].stamps.admit()).toBe("admitted");
		},
	);

	it("ignores a rival already spawned", () => {
		const seats = pair();
		stamp(seats[22]);
		seats[22].spawned();
		expect(seats[11].stamps.admit()).toBe("admitted");
	});

	it("never launches both unspawned", async () => {
		const seats = pair(undefined, undefined, { weight: PART });
		const launched: (11 | 22)[] = [];
		const beside: boolean[] = [];
		const wait = (pid: 11 | 22) =>
			seats[pid]
				.wait({
					gate: () => null,
					hold: () => Promise.resolve(true),
					sleepFn: () => {
						for (const done of launched) seats[done].spawned();
						return Promise.resolve();
					},
					out: { write: () => true },
				})
				.then((outcome: string) => {
					const rival = seats[pid === 11 ? 22 : 11];
					const record = JSON.parse(fs.readFileSync(rival.ticket, "utf8"));
					beside.push(record.admitted === true && record.spawned !== true);
					launched.push(pid);
					expect(outcome).toBe("run");
				});
		await Promise.all([wait(11), wait(22)]);
		expect(launched).toHaveLength(2);
		expect(beside).toEqual([false, false]);
	});
});

describe("a suite and a `tsc` admitted on one poll (#3203)", () => {
	type Seat = ReturnType<typeof queueSeat>;
	const alive = () => true;
	interface Waiter {
		pid: number;
		queueDir: string;
		seat: Seat;
	}
	const queues = (hooked?: "suite" | "tsc", between?: () => void) => {
		const root = qdir();
		const onReread = {
			...fs,
			readdirSync: (dir: string) => {
				between?.();
				return fs.readdirSync(dir);
			},
		};
		const waiter = (
			key: "suite" | "tsc",
			name: string,
			pid: number,
		): Waiter => {
			const queueDir = path.join(root, name);
			const seat = queueSeat({
				queue: {
					queueDir,
					pid,
					clock: () => pid,
					alive,
					...(key === hooked ? { queueFs: onReread } : {}),
				},
			});
			return { pid, queueDir, seat };
		};
		return {
			suite: waiter("suite", "wfc-suite-queue", 11),
			tsc: waiter("tsc", "wfc-tsc-queue", 22),
		};
	};
	const stamped = (w: Waiter) =>
		JSON.parse(fs.readFileSync(w.seat.ticket, "utf8"));
	const turn = (w: Waiter) => turnOpen({ queueDir: w.queueDir, pid: w.pid });

	it.each([
		["the suite", "suite", "tsc", "ahead"],
		["the `tsc`", "tsc", "suite", "behind"],
	] as const)(
		"yields as %s where both stamped before either re-read",
		(_, mine, theirs, how) => {
			const waiters = queues(mine, () => {
				const rival = waiters[theirs];
				fs.writeFileSync(
					rival.seat.ticket,
					JSON.stringify({ ...stamped(rival), admitted: true }),
				);
			});
			expect(waiters[mine].seat.stamps.admit()).toBe(how);
			expect(stamped(waiters[mine]).admitted).toBeUndefined();
			expect(waiters[theirs].seat.stamps.admit()).toBe("admitted");
		},
	);

	it("closes the other queue's turn until the admitted launch spawns", async () => {
		const { suite, tsc } = queues();
		expect(tsc.seat.stamps.admit()).toBe("admitted");
		expect(await turn(suite)).toBe(false);
		tsc.seat.spawned();
		expect(await turn(suite)).toBe(true);
	});

	it("names the peer launch admitted and not yet up that holds a traced wait (#4359)", async () => {
		const { suite, tsc } = queues();
		expect(suite.seat.stamps.admit()).toBe("admitted");
		const lines: string[] = [];
		const outcome = await tsc.seat.wait({
			gate: () => null,
			monoClock: () => 0,
			traceLimbs: true,
			label: "q",
			waiting: "waiting",
			sleepFn: () => {
				suite.seat.spawned();
				return Promise.resolve();
			},
			out: { write: (line: string) => lines.push(line) },
		});
		expect(outcome).toBe("run");
		expect(lines.slice(0, 2)).toEqual([
			"q: waiting\n",
			"q: after 0s, held on a launch admitted and not yet up, PID 11 in wfc-suite-queue\n",
		]);
		expect(lines[2]).toBe(
			"q: gate opened after 0s — held 0s on a launch admitted and not yet up\n",
		);
	});

	it("names the admission, not the waiter ahead it also holds, where both close the turn (#4359)", async () => {
		const { suite, tsc } = queues();
		const ahead = joined(tsc.queueDir, 21, 21);
		expect(suite.seat.stamps.admit()).toBe("admitted");
		const lines: string[] = [];
		let polls = 0;
		await tsc.seat.wait({
			gate: () => null,
			monoClock: () => 0,
			traceLimbs: true,
			label: "q",
			waiting: "waiting",
			sleepFn: () => {
				if (++polls === 1) suite.seat.spawned();
				else ahead.leave();
				return Promise.resolve();
			},
			out: { write: (line: string) => lines.push(line) },
		});
		expect(lines.slice(1, 3)).toEqual([
			"q: after 0s, held on a launch admitted and not yet up, PID 11 in wfc-suite-queue\n",
			"q: after 0s, held on the waiters ahead, PID 21\n",
		]);
	});

	it("reads no peer for a queue directory of another name", async () => {
		const { tsc } = queues();
		const queueDir = qdir();
		const other = { pid: 33, queueDir, seat: joined(queueDir, 33, 33) };
		tsc.seat.stamps.admit();
		expect(await turn(other)).toBe(true);
		expect(other.seat.stamps.admit()).toBe("admitted");
	});

	it("never launches both unspawned", async () => {
		const { suite, tsc } = queues();
		const launched: Waiter[] = [];
		const beside: boolean[] = [];
		const wait = (w: Waiter, rival: Waiter) =>
			w.seat
				.wait({
					gate: () => null,
					hold: () => Promise.resolve(true),
					sleepFn: () => {
						for (const done of launched) done.seat.spawned();
						return Promise.resolve();
					},
					out: { write: () => true },
				})
				.then((outcome: string) => {
					const record = stamped(rival);
					beside.push(record.admitted === true && record.spawned !== true);
					launched.push(w);
					expect(outcome).toBe("run");
				});
		await Promise.all([wait(suite, tsc), wait(tsc, suite)]);
		expect(launched).toHaveLength(2);
		expect(beside).toEqual([false, false]);
	});
});

describe("the queues ordered against each other where the climb decides (#4760)", () => {
	const both = () => {
		const root = qdir();
		return {
			suiteDir: path.join(root, "wfc-suite-queue"),
			tscDir: path.join(root, "wfc-tsc-queue"),
		};
	};

	it("closes every class of turn on a peer the climb holds, and none without", () => {
		for (const waiter of ["whole", "part", "tsc"] as const) {
			const snapshot = {
				waiter,
				ahead: [],
				admissionOpen: false,
				slots: WHOLE_SUITE_MAX,
				now: 0,
			};
			expect(turnOf({ ...snapshot, peerClimbHeld: true }).reasons).toEqual([
				"peer-climb",
			]);
			expect(turnOf(snapshot).reasons).toEqual([]);
		}
	});

	it("holds a younger suite behind an older `tsc` the climb holds, until it spawns", async () => {
		const { suiteDir, tscDir } = both();
		const tsc = joined(tscDir, 22, 5);
		joined(suiteDir, 11, 10);
		const suiteTurn = () => turnOpen({ queueDir: suiteDir, pid: 11 });
		expect(await suiteTurn()).toBe(true);
		tsc.stamps.onClimbStamp(true);
		expect(await suiteTurn()).toBe(false);
		tsc.spawned();
		expect(await suiteTurn()).toBe(true);
	});

	it("releases the suite once the climb no longer holds the `tsc`", async () => {
		const { suiteDir, tscDir } = both();
		const tsc = joined(tscDir, 22, 5);
		joined(suiteDir, 11, 10);
		tsc.stamps.onClimbStamp(true);
		tsc.stamps.onClimbStamp(false);
		expect(JSON.parse(fs.readFileSync(tsc.ticket, "utf8")).climbHeld).toBe(
			undefined,
		);
		expect(await turnOpen({ queueDir: suiteDir, pid: 11 })).toBe(true);
	});

	it("never holds a waiter behind a younger peer, so the oldest never yields", async () => {
		const { suiteDir, tscDir } = both();
		joined(tscDir, 22, 20).stamps.onClimbStamp(true);
		joined(suiteDir, 11, 10).stamps.onClimbStamp(true);
		expect(await turnOpen({ queueDir: suiteDir, pid: 11 })).toBe(true);
		expect(await turnOpen({ queueDir: tscDir, pid: 22 })).toBe(false);
	});

	it("names the peer that holds a traced wait", async () => {
		const { suiteDir, tscDir } = both();
		const tsc = joined(tscDir, 22, 5);
		tsc.stamps.onClimbStamp(true);
		const suite = joined(suiteDir, 11, 10);
		const lines: string[] = [];
		const outcome = await suite.wait({
			gate: () => null,
			traceLimbs: true,
			label: "q",
			waiting: "waiting",
			sleepFn: () => {
				tsc.spawned();
				return Promise.resolve();
			},
			out: { write: (line: string) => lines.push(line) },
		});
		expect(outcome).toBe("run");
		expect(lines[1]).toBe(
			"q: after 0s, held on an older waiter in the other queue the climb charge holds, PID 22 in wfc-tsc-queue\n",
		);
	});
});

describe("a stamp the climb set, kept while running launches hold the wait (#4799)", () => {
	const climbed = { limb: "memory", mb: 3666, rungMb: 3350, climbMb: 1587 };
	const windows = { limb: "windows", mb: 900 };
	const drawn = { limb: "memory", mb: 3100, rungMb: 3350, climbMb: 1587 };

	it("keeps it on the rung or the Windows hold while charged, and drops it once nothing is", async () => {
		const polls = [
			{ denial: climbed, charged: 1587 },
			{ denial: windows, charged: 1200 },
			{ denial: drawn, charged: 900 },
			{ denial: drawn, charged: 0 },
			{ denial: windows, charged: 400 },
		];
		let poll: { denial: object | null; charged: number } = {
			denial: null,
			charged: 0,
		};
		let held = false;
		const stampAtPoll: boolean[] = [];
		await waitForGate({
			climbMb: () => {
				poll = polls.shift() ?? { denial: null, charged: 0 };
				return poll.charged;
			},
			gate: () => poll.denial,
			admit: noQueue,
			sleepFn: () => {
				stampAtPoll.push(held);
				return Promise.resolve();
			},
			out: { write: () => true },
			onClimbStamp: (stamp: boolean) => {
				held = stamp;
			},
		});
		expect(stampAtPoll).toEqual([true, true, true, false, false]);
	});

	it("holds a younger `tsc` back throughout a head the memory and Windows limbs deny in turn", async () => {
		const root = qdir();
		const suiteDir = path.join(root, "wfc-suite-queue");
		const tscDir = path.join(root, "wfc-tsc-queue");
		const head = joined(suiteDir, 11, 5);
		joined(tscDir, 22, 10);
		const polls = [climbed, windows, drawn, windows, climbed];
		const tscTurns: boolean[] = [];
		const outcome = await waitForGate({
			climbMb: () => 1500,
			gate: () => polls.shift() ?? null,
			admit: noQueue,
			sleepFn: async () => {
				tscTurns.push(await turnOpen({ queueDir: tscDir, pid: 22 }));
			},
			out: { write: () => true },
			onClimbStamp: head.stamps.onClimbStamp,
		});
		expect(outcome).toBe("run");
		expect(tscTurns).toEqual([false, false, false, false, false]);
		expect(await turnOpen({ queueDir: tscDir, pid: 22 })).toBe(true);
	});
});

describe("a launch still climbing, on the other queue's rung (#3416)", () => {
	const alive = () => true;
	const noRunners = () => ({
		ok: true as const,
		rows: [{ pid: 1, args: "/sbin/init" }],
	});
	const climbingTsc = () => {
		const polls = [
			{ tsc: 300, freed: 0 },
			{ tsc: 900, freed: 0 },
			{ tsc: 1000, freed: 700 },
		];
		let poll = 0;
		const at = () => polls[Math.min(poll, polls.length - 1)] ?? polls[0];
		const live: number[] = [];
		return {
			live,
			polled: () => poll,
			treePssKb: () => at().tsc * 1024,
			gateRead: (_c: string, _w: unknown, climbMb: number) => {
				const mb = 6500 - at().tsc + at().freed;
				live.push(mb);
				return mb - climbMb < 5000
					? { limb: "memory", mb, rungMb: 5000, climbMb }
					: null;
			},
			sleepFn: () => {
				poll++;
				return Promise.resolve();
			},
		};
	};
	const queues = () => {
		const root = qdir();
		return {
			suiteDir: path.join(root, "wfc-suite-queue"),
			tscDir: path.join(root, "wfc-tsc-queue"),
		};
	};
	const spawnedIn = (queueDir: string, pid: number) => {
		const seat = joined(queueDir, pid, 0);
		seat.spawned();
		return seat;
	};
	const climbOf = (
		queueDir: string,
		mb: number,
		live: (pid: number) => boolean = alive,
	) =>
		seatStamps({
			queueDir,
			alive: live,
			ps: noRunners,
			treePssKb: () => mb * 1024,
		}).climbMb();

	it("charges a spawned `tsc` its peak less its tree, never below 0", () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(tscDir, 22);
		expect(climbOf(suiteDir, 400)).toBe(TSC_PEAK_MB - 400);
		expect(climbOf(suiteDir, TSC_PEAK_MB + 1)).toBe(0);
	});

	it("charges a spawned `tsc` the peak of the compiler its marker names (#4892)", () => {
		const { suiteDir, tscDir } = queues();
		joined(tscDir, 22, 0, { chargeMb: TSC7_PEAK_MB }).spawned();
		expect(climbOf(suiteDir, 400)).toBe(TSC7_PEAK_MB - 400);
		joined(tscDir, 23, 0, { chargeMb: TSC5_PEAK_MB }).spawned();
		expect(climbOf(suiteDir, 400)).toBe(
			TSC7_PEAK_MB - 400 + TSC5_PEAK_MB - 400,
		);
	});

	it("charges nothing for a held seat stamped `yielding`, and its peak once the stamp drops (#4766)", () => {
		const { suiteDir, tscDir } = queues();
		const seat = spawnedIn(suiteDir, 11);
		const stamp = (yielding: boolean) => {
			const record = JSON.parse(fs.readFileSync(seat.ticket, "utf8"));
			fs.writeFileSync(seat.ticket, JSON.stringify({ ...record, yielding }));
		};
		stamp(true);
		expect(climbOf(tscDir, 100)).toBe(0);
		stamp(false);
		expect(climbOf(tscDir, 100)).toBe(SUITE_PEAK_MB - 100);
	});

	it("charges a spawned suite its measured peak less its tree", () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(suiteDir, 11);
		expect(climbOf(tscDir, 100)).toBe(SUITE_PEAK_MB - 100);
	});

	const partIn = (
		queueDir: string,
		pid: number,
		resolvedFiles: number | null,
	) => {
		const seat = joined(queueDir, pid, 0, {
			weight: { resolvedFiles, wholeSlot: false },
		});
		seat.spawned();
		return seat;
	};

	it("charges a part-suite its own peak by its workers and files (#3806)", () => {
		const { suiteDir, tscDir } = queues();
		partIn(suiteDir, 11, 1);
		const one = launchChargeMb({ kind: "part", files: 1, workers: 1 }) - 100;
		expect(climbOf(tscDir, 100)).toBe(one);
		partIn(suiteDir, 12, 40);
		expect(climbOf(tscDir, 100)).toBe(
			one + launchChargeMb({ kind: "part", files: 40, workers: 5 }) - 100,
		);
	});

	it("charges a spawned part-suite the p99 its gate stamped at spawn, else its line (#5366)", () => {
		const { suiteDir, tscDir } = queues();
		const join = {
			weight: { resolvedFiles: 1, wholeSlot: false },
			kind: "named" as const,
		};
		joined(suiteDir, 11, 0, join).spawned({ chargeMb: 609 });
		expect(climbOf(tscDir, 100)).toBe(609 - 100);
		const ladder = queues();
		joined(ladder.suiteDir, 12, 0, join).spawned();
		expect(climbOf(ladder.tscDir, 100)).toBe(
			launchChargeMb({ kind: "part", files: 1, workers: 1 }) - 100,
		);
	});

	it("never charges a part-suite above a whole suite's peak", () => {
		const { suiteDir, tscDir } = queues();
		partIn(suiteDir, 11, 500);
		expect(climbOf(tscDir, 100)).toBe(SUITE_PEAK_MB - 100);
	});

	it("charges a lander marker the charge it carries (#3973)", () => {
		const { suiteDir, tscDir } = queues();
		const named = launchChargeMb({ kind: "lander", files: ["a.test.ts"] });
		joined(suiteDir, 11, 0, { role: "lander", chargeMb: named }).spawned();
		expect(climbOf(tscDir, 100)).toBe(named - 100);
	});

	it("never caps a lander marker's carried charge at a whole suite's peak (#3973)", () => {
		const { suiteDir, tscDir } = queues();
		const above = SUITE_PEAK_MB + 500;
		joined(suiteDir, 11, 0, { role: "lander", chargeMb: above }).spawned();
		expect(climbOf(tscDir, 100)).toBe(above - 100);
	});

	it("charges a queued pytest its runner's peak, not a whole suite's (#4648)", () => {
		const { suiteDir, tscDir } = queues();
		const chargeMb = queuedRunnerPeakMb(["python3", "-m", "pytest", "-n", "2"]);
		joined(suiteDir, 11, 0, { chargeMb }).spawned();
		expect(climbOf(tscDir, 100)).toBe(
			launchChargeMb({ kind: "pytest", workers: 2 }) - 100,
		);
	});

	it("charges a queued `npm run test:py` pytest's peak at its workers (#4775)", () => {
		expect(queuedRunnerPeakMb(["npm", "run", "test:py", "--", "scripts"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 2 }),
		);
		expect(queuedRunnerPeakMb(["npm", "test:py", "--", "-n", "4"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 4 }),
		);
		expect(
			queuedRunnerPeakMb(["node", "scripts/run-pytest.js", "--full"]),
		).toBe(launchChargeMb({ kind: "pytest", workers: 2 }));
		expect(queuedRunnerPeakMb(["npm", "run", "test"])).toBe(undefined);
	});

	it("reads a queued launch's peak off its runner class (#4648)", () => {
		expect(queuedRunnerPeakMb(["pytest", "-n", "8"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 8 }),
		);
		expect(queuedRunnerPeakMb(["python3", "a.test.py"])).toBe(
			launchChargeMb({ kind: "pytest", workers: 0 }),
		);
		expect(queuedRunnerPeakMb(["node", "--test", "a.test.js"])).toBe(
			launchChargeMb({ kind: "node-test" }),
		);
		expect(queuedRunnerPeakMb(["node", "scripts/run-host-suite.js"])).toBe(
			undefined,
		);
		expect(queuedRunnerPeakMb(["node", "node_modules/.bin/tsc"])).toBe(
			undefined,
		);
		expect(
			queuedRunnerPeakMb(["node", "node_modules/.bin/vitest", "run"]),
		).toBe(undefined);
	});

	it("charges a lander marker carrying no charge its queue's peak", () => {
		const { suiteDir, tscDir } = queues();
		joined(suiteDir, 11, 0, { role: "lander" }).spawned();
		expect(climbOf(tscDir, 100)).toBe(SUITE_PEAK_MB - 100);
	});

	it("charges a part marker with no file count its queue's peak", () => {
		const { suiteDir, tscDir } = queues();
		partIn(suiteDir, 11, null);
		expect(climbOf(tscDir, 100)).toBe(SUITE_PEAK_MB - 100);
	});

	it("admits a `tsc` beside two small part-suites and holds it beside a whole suite still climbing (#3806)", async () => {
		const { suiteDir, tscDir } = queues();
		const waitOnce = async () => {
			const exits: unknown[][] = [];
			const outcome = await waitForGate({
				pollMs: 1,
				timeoutMs: 0,
				...seatStamps({
					queueDir: tscDir,
					alive,
					ps: noRunners,
					treePssKb: () => 500 * 1024,
				}),
				gate: (climbMb: number) => tscDenial([], 4000, climbMb),
				sleepFn: () => Promise.resolve(),
				out: { write: () => true },
				onExit: (...args: unknown[]) => exits.push(args),
			});
			return { outcome, exits };
		};
		const small = [partIn(suiteDir, 11, 2), partIn(suiteDir, 12, 2)];
		expect((await waitOnce()).outcome).toBe("run");
		for (const seat of small) seat.leave();
		spawnedIn(suiteDir, 13);
		const beside = await waitOnce();
		expect(beside.outcome).toBe("refused");
		expect(beside.exits[0][2]).toEqual({
			limb: "memory",
			climbMb: SUITE_PEAK_MB - 500,
		});
	});

	it("charges none for a launch unspawned or stale, nor for its own queue's", () => {
		const { suiteDir, tscDir } = queues();
		joined(tscDir, 22, 0);
		expect(climbOf(suiteDir, 400)).toBe(0);
		spawnedIn(tscDir, 22);
		expect(climbOf(tscDir, 400)).toBe(0);
		expect(climbOf(suiteDir, 400, () => false)).toBe(0);
	});

	it("charges both queues' launches to a launch in neither (#3488)", () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(suiteDir, 11);
		spawnedIn(tscDir, 22);
		vi.stubEnv("TMPDIR", path.dirname(suiteDir));
		const options = { alive, ps: noRunners, treePssKb: () => 100 * 1024 };
		expect(readQueuesClimbMb("all", options)).toBe(
			SUITE_PEAK_MB - 100 + TSC_PEAK_MB - 100,
		);
		expect(readQueuesClimbMb("off-rung", options)).toBe(
			SUITE_PEAK_MB - 100 + TSC_PEAK_MB - 100,
		);
	});

	it("holds a suite admitted just after a `tsc` spawns until that `tsc`'s remaining climb fits", async () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(tscDir, 22);
		const m = climbingTsc();
		const outcome = await queueSeat({
			queue: {
				queueDir: suiteDir,
				pid: 11,
				clock: () => 0,
				alive,
				ps: noRunners,
				treePssKb: m.treePssKb,
			},
		}).wait({
			gateRead: m.gateRead,
			sleepFn: m.sleepFn,
			out: { write: () => true },
		});
		expect(outcome).toBe("run");
		expect(m.polled()).toBe(2);
		expect(m.live.slice(0, 2).every((mb) => mb >= 5000)).toBe(true);
		expect(fs.existsSync(path.join(tscDir, "wfc-suite-queue-22.json"))).toBe(
			true,
		);
	});

	describe("a launch in no queue, off `ps` (#3615)", () => {
		const Tsc = "node /r/node_modules/.bin/tsc --noEmit";
		const Vitest = "node /r/node_modules/.bin/vitest run";
		const noCarried: (pid: number | null) => {
			resolvedFiles: number | null;
			wholeSlot: boolean;
		} | null = () => null;
		const machine = (
			rows: Record<number, string>,
			parents: Record<number, number> = {},
		) => ({
			alive: alive as (pid: number) => boolean,
			ps: () => ({
				ok: true as const,
				rows: Object.entries(rows).map(([pid, args]) => ({
					pid: Number(pid),
					args,
				})),
			}),
			parentOf: (pid: number) => parents[pid] ?? 0,
			carriedOf: noCarried,
			treePssKb: () => 400 * 1024,
		});
		const climbOn = (queueDir: string, m: ReturnType<typeof machine>) =>
			seatStamps({ queueDir, ...m }).climbMb();

		it("holds a queued suite while a `tsc` the guard admitted is still climbing", async () => {
			const { suiteDir } = queues();
			const m = climbingTsc();
			const outcome = await queueSeat({
				queue: {
					queueDir: suiteDir,
					pid: 11,
					clock: () => 0,
					...machine({ 22: Tsc }),
					treePssKb: m.treePssKb,
				},
			}).wait({
				gateRead: m.gateRead,
				sleepFn: m.sleepFn,
				out: { write: () => true },
			});
			expect(outcome).toBe("run");
			expect(m.polled()).toBe(2);
		});

		it("charges a runner the real `ps` read lists at WFC_PS", () => {
			const { suiteDir } = queues();
			vi.stubEnv(
				"WFC_PS",
				writePsStub(path.dirname(suiteDir), [`22 ${Tsc}`, `23 sh -c ${Tsc}`]),
			);
			const { ps: _fake, ...real } = machine({});
			expect(seatStamps({ queueDir: suiteDir, ...real }).climbMb()).toBe(
				TSC_PEAK_MB - 400,
			);
		});

		it("charges an unmarked `tsc` its own compiler's peak, read off its line (#4892)", () => {
			const { suiteDir } = queues();
			const tree = path.join(path.dirname(suiteDir), "five", "node_modules");
			const pkg = path.join(tree, "typescript");
			fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
			fs.writeFileSync(
				path.join(pkg, "package.json"),
				JSON.stringify({ version: "5.9.3" }),
			);
			fs.writeFileSync(path.join(pkg, "bin", "tsc"), "");
			const native =
				"/r/node_modules/@typescript/typescript-linux-arm64/lib/tsc --noEmit";
			expect(climbOn(suiteDir, machine({ 22: native }))).toBe(
				TSC7_PEAK_MB - 400,
			);
			expect(
				climbOn(suiteDir, machine({ 22: `node ${pkg}/bin/tsc --noEmit` })),
			).toBe(TSC5_PEAK_MB - 400);
		});

		it("names a sibling queue that will not read, its runners left unmarked", () => {
			const { suiteDir } = queues();
			const unread: string[] = [];
			const refusing = {
				...fs,
				readdirSync: ((dir: string) => {
					if (dir === suiteDir) throw new Error("EACCES");
					return fs.readdirSync(dir);
				}) as typeof fs.readdirSync,
			};
			const climb = seatStamps({
				queueDir: suiteDir,
				queueFs: refusing,
				...machine({ 22: Tsc }),
				onUnread: (dir: string) => unread.push(dir),
			}).climbMb();
			expect(climb).toBe(TSC_PEAK_MB - 400);
			expect(unread).toEqual([suiteDir]);
		});

		it("charges each to the queue it would have waited in, the other queue's gate paying", () => {
			const { suiteDir, tscDir } = queues();
			const m = machine({ 22: Tsc, 33: Vitest });
			expect(climbOn(suiteDir, m)).toBe(TSC_PEAK_MB - 400);
			expect(climbOn(tscDir, m)).toBe(SUITE_PEAK_MB - 400);
			vi.stubEnv("TMPDIR", path.dirname(suiteDir));
			expect(readQueuesClimbMb("all", m)).toBe(
				TSC_PEAK_MB - 400 + SUITE_PEAK_MB - 400,
			);
			expect(readQueuesClimbMb("off-rung", m)).toBe(TSC_PEAK_MB - 400);
		});

		describe("a runner on no queue's own count, on its measured peak (#4112)", () => {
			const Pytest = "python3 -m pytest -n 2 -p pytest_pass_plugin scripts";
			const NodeTest = "node --test test/a.test.js";
			const Build = "node /r/node_modules/.bin/next build";

			it("charges pytest by its xdist workers, at the `tsc` gate alone", () => {
				const { suiteDir, tscDir } = queues();
				expect(
					climbOn(tscDir, { ...machine({ 33: Pytest }), treePssKb: () => 0 }),
				).toBe(launchChargeMb({ kind: "pytest", workers: 2 }));
				const m = { ...machine({ 33: "pytest -n 8" }), treePssKb: () => 0 };
				expect(climbOn(tscDir, m)).toBe(
					launchChargeMb({ kind: "pytest", workers: 8 }),
				);
				expect(climbOn(suiteDir, m)).toBe(0);
				vi.stubEnv("TMPDIR", path.dirname(suiteDir));
				expect(readQueuesClimbMb("off-rung", m)).toBe(0);
				expect(readQueuesClimbMb("all", m)).toBe(
					launchChargeMb({ kind: "pytest", workers: 8 }),
				);
			});

			it("reads `-n auto` as a worker a CPU, and no `-n` as none", () => {
				const { tscDir } = queues();
				const at = (args: string) =>
					climbOn(tscDir, { ...machine({ 33: args }), treePssKb: () => 0 });
				expect(at("python3 -m pytest -n auto")).toBe(
					launchChargeMb({
						kind: "pytest",
						workers: os.availableParallelism(),
					}),
				);
				expect(at("python3 -m pytest --numprocesses=3")).toBe(
					launchChargeMb({ kind: "pytest", workers: 3 }),
				);
				expect(at("python3 -m pytest -n=4")).toBe(
					launchChargeMb({ kind: "pytest", workers: 4 }),
				);
				expect(at("python3 -m pytest -n2")).toBe(
					launchChargeMb({ kind: "pytest", workers: 2 }),
				);
				expect(at("python3 -m pytest -q")).toBe(
					launchChargeMb({ kind: "pytest", workers: 0 }),
				);
			});

			it("charges `node --test` its one measured peak", () => {
				const { tscDir } = queues();
				expect(
					climbOn(tscDir, { ...machine({ 33: NodeTest }), treePssKb: () => 0 }),
				).toBe(launchChargeMb({ kind: "node-test" }));
			});

			it("charges a build at every gate, no rung counting it", () => {
				const { suiteDir, tscDir } = queues();
				const m = machine({ 44: Build });
				expect(climbOn(suiteDir, m)).toBe(
					launchChargeMb({ kind: "next-build" }) - 400,
				);
				expect(climbOn(tscDir, m)).toBe(
					launchChargeMb({ kind: "next-build" }) - 400,
				);
				vi.stubEnv("TMPDIR", path.dirname(suiteDir));
				expect(readQueuesClimbMb("off-rung", m)).toBe(
					launchChargeMb({ kind: "next-build" }) - 400,
				);
				expect(readQueuesClimbMb("all", m)).toBe(
					launchChargeMb({ kind: "next-build" }) - 400,
				);
			});

			it("charges no host runner, npm's shell line or a pytest worker", () => {
				const { tscDir } = queues();
				const m = machine({
					1: "node scripts/run-host-suite.js",
					2: "sh -c next build",
					3: 'python3 -c "import sys;exec(eval(sys.stdin.readline()))"',
				});
				expect(climbOn(tscDir, m)).toBe(0);
			});
		});

		it("charges a marked suite whose vitest is on `ps` nothing off the rung (#4111)", () => {
			const { suiteDir, tscDir } = queues();
			spawnedIn(suiteDir, 11);
			spawnedIn(tscDir, 22);
			const m = machine({ 22: Tsc, 33: Vitest }, { 33: 11 });
			vi.stubEnv("TMPDIR", path.dirname(suiteDir));
			expect(readQueuesClimbMb("all", m)).toBe(
				TSC_PEAK_MB - 400 + SUITE_PEAK_MB - 400,
			);
			expect(readQueuesClimbMb("off-rung", m)).toBe(TSC_PEAK_MB - 400);
		});

		it("charges a part-suite its own peak, off its words or its launch record", () => {
			const { tscDir } = queues();
			const named = `${Vitest} scripts/a.test.ts scripts/b.test.ts`;
			expect(climbOn(tscDir, machine({ 33: named }))).toBe(
				launchChargeMb({ kind: "part", files: 2, workers: 2 }) - 400,
			);
			expect(
				climbOn(tscDir, {
					...machine({ 33: Vitest }),
					carriedOf: () => ({ resolvedFiles: 4, wholeSlot: false }),
				}),
			).toBe(launchChargeMb({ kind: "part", files: 4, workers: 4 }) - 400);
		});

		it("leaves out a runner under a live marker in either queue, charging it once", () => {
			const { suiteDir, tscDir } = queues();
			spawnedIn(tscDir, 40);
			const inSlot = machine({ 22: Tsc }, { 22: 40 });
			expect(climbOn(suiteDir, inSlot)).toBe(TSC_PEAK_MB - 400);
			spawnedIn(suiteDir, 50);
			const underSuite = machine({ 33: Tsc }, { 33: 50 });
			expect(climbOn(tscDir, underSuite)).toBe(SUITE_PEAK_MB - 400);
		});

		it("charges a queued pytest once, on its marker's stamp (#4648)", () => {
			const { suiteDir, tscDir } = queues();
			const chargeMb = queuedRunnerPeakMb(["pytest", "-n", "2"]);
			joined(suiteDir, 50, 0, { chargeMb }).spawned();
			const m = machine({ 33: "pytest -n 2" }, { 33: 50 });
			expect(climbOn(tscDir, { ...m, treePssKb: () => 0 })).toBe(
				launchChargeMb({ kind: "pytest", workers: 2 }),
			);
		});

		it("charges a runner whose marker's holder is dead", () => {
			const { suiteDir, tscDir } = queues();
			spawnedIn(tscDir, 40);
			const m = machine({ 22: Tsc }, { 22: 40 });
			expect(
				climbOn(suiteDir, { ...m, alive: (pid: number) => pid !== 40 }),
			).toBe(TSC_PEAK_MB - 400);
		});

		it("leaves out a runner under another runner, whose tree holds it", () => {
			const { suiteDir } = queues();
			const m = machine({ 33: Vitest, 22: Tsc }, { 22: 33 });
			expect(climbOn(suiteDir, m)).toBe(0);
		});

		it("reads no shell line, waiter or `vitest list` as a runner", () => {
			const { suiteDir, tscDir } = queues();
			const m = machine({
				1: `sh -c ${Vitest}`,
				2: "node /r/scripts/queue-run.js --tsc -- /r/node_modules/.bin/tsc",
				3: "node /r/node_modules/.bin/vitest list",
			});
			expect(climbOn(suiteDir, m)).toBe(0);
			expect(climbOn(tscDir, m)).toBe(0);
		});

		it("charges none on a `ps` that will not run, naming it", () => {
			const { suiteDir } = queues();
			const unread: string[] = [];
			const climb = seatStamps({
				queueDir: suiteDir,
				alive,
				ps: () => ({ ok: false as const, error: "ps listed nothing" }),
				onUnread: (dir: string) => unread.push(dir),
			}).climbMb();
			expect(climb).toBe(0);
			expect(unread).toEqual(["ps"]);
		});
	});
});

describe("queueSeat's wait, composing the gate from the launch's words, read and weight (#5654)", () => {
	const sleepsUnder = async (
		gateRead: (command: string) => { limb: string } | null,
		gateWords?: string[],
	) => {
		const sleepFn = vi.fn(() => Promise.resolve());
		await seatWait({
			gateRead,
			gateWords,
			admit: noQueue,
			sleepFn,
			out: { write: () => true },
		});
		return sleepFn.mock.calls.length;
	};

	it("fails open when the gate cannot be read", async () => {
		expect(
			await sleepsUnder(() => {
				throw new Error("ENOENT");
			}),
		).toBe(0);
	});

	it("asks the gate about the launch's own words", async () => {
		const gateRead = vi.fn(() => null);
		await sleepsUnder(gateRead, ["a.test.ts"]);
		expect(gateRead).toHaveBeenCalledWith(
			"npm run test -- a.test.ts",
			null,
			0,
			expect.any(Function),
		);
	});

	it("hands the gate the weight the launch carries (#2931)", async () => {
		const gateRead = vi.fn(() => null);
		const gateWeight = weighed(40);
		await seatWait({
			gateRead,
			gateWords: ["--changed"],
			gateWeight,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
		});
		expect(gateRead).toHaveBeenCalledWith(
			"npm run test -- --changed",
			gateWeight,
			0,
			expect.any(Function),
		);
	});

	it("waits on each deny the gate reads", async () => {
		let denies = 2;
		const deny = () => (denies-- > 0 ? { limb: "count" } : null);
		expect(await sleepsUnder(deny)).toBe(2);
	});

	it("records how the gate's last reading judged a part-suite on its exit line (#5366)", async () => {
		const peak = {
			mode: "peak",
			kind: "named",
			bucket: "1",
			p99Mb: 609,
			rungMb: 1750,
			climbMb: 0,
			samples: 683,
		};
		const ladder = { ...peak, mode: "ladder", cause: "tripped" };
		const heard: unknown[] = [];
		for (const admission of [peak, ladder]) {
			const exits: unknown[][] = [];
			await seatWait(
				{
					gateRead: (
						_command: string,
						_weight: unknown,
						_climb: number,
						hear?: (a: unknown) => void,
					) => {
						hear?.(admission);
						return null;
					},
					admit: noQueue,
					sleepFn: () => Promise.resolve(),
					out: { write: () => true },
					onAdmission: (a: unknown) => heard.push(a),
				},
				(...args: unknown[]) => exits.push(args),
			);
			expect(exits).toEqual([["opened", expect.any(Number), { admission }]]);
		}
		expect(heard).toEqual([peak, ladder]);
	});
});

describe("gateDenies, the command it asks the gate about (#2558)", () => {
	it.each([
		[[], "npm run test"],
		[["a.test.ts"], "npm run test -- a.test.ts"],
		[
			["a.test.ts", "-t", "two words"],
			"npm run test -- a.test.ts -t 'two words'",
		],
	])("asks about %j as `%s`", (words, command) => {
		const read = vi.fn(() => null);
		expect(gateDenies(words, read)).toBeNull();
		expect(read).toHaveBeenCalledWith(command, null, 0);
	});

	it("hands back the limb the gate reads", () => {
		expect(gateDenies([], () => ({ limb: "count" }))).toEqual({
			limb: "count",
		});
	});

	it("fails open on a gate that cannot be read", () => {
		expect(
			gateDenies([], () => {
				throw new Error("boom");
			}),
		).toBeNull();
	});
});

describe("gateDenies, against the real gate (#2421)", () => {
	const { readGate } = require("./suite-concurrency-host.js");

	const ask = (
		mb: number,
		suites: number,
		words: string[] = [],
		{
			weight = null,
			config = null,
			climbMb = 0,
		}: {
			weight?: { resolvedFiles: number | null; wholeSlot: boolean } | null;
			config?: string | null;
			climbMb?: number;
		} = {},
	) => {
		const dir = qdir();
		if (config !== null) {
			fs.mkdirSync(path.join(dir, ".claude"));
			fs.writeFileSync(path.join(dir, ".claude", "workflow-core.json"), config);
		}
		const meminfo = path.join(dir, "meminfo");
		fs.writeFileSync(meminfo, `MemAvailable: ${mb * 1024} kB\n`);
		vi.stubEnv("WFC_MEMINFO", meminfo);
		vi.stubEnv(
			"WFC_PS",
			writePsStub(
				dir,
				Array.from(
					{ length: suites },
					() => "node /r/node_modules/.bin/vitest run",
				),
			),
		);
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "config"));
		return gateDenies(
			words,
			(command: string, carried: typeof weight, climb: number) =>
				readGate(command, dir, {
					weight: carried,
					climbMb: climb,
					allClimbMb: () => climb,
					gateSeats: noSeats,
				}),
			weight,
			{ climbMb },
		);
	};

	it("names the memory limb, with the reading and the rung", () => {
		expect(ask(500, 0)).toEqual({
			limb: "memory",
			mb: 500,
			rungMb: expect.any(Number),
		});
	});

	it("charges the climb off MemAvailable, giving the reading itself and the charge apart", () => {
		expect(ask(4000, 0)).toBeNull();
		expect(ask(4000, 0, [], { climbMb: 1500 })).toEqual({
			limb: "memory",
			mb: 4000,
			rungMb: expect.any(Number),
			climbMb: 1500,
		});
	});

	it("names the count limb on a second whole suite, and lets a part-suite through", () => {
		expect(ask(20_000, 1, ["--changed"])).toEqual({ limb: "count" });
		expect(ask(20_000, 1, ["scripts/a.test.ts"])).toBeNull();
	});

	it("admits a touched run while a whole suite holds the slot, a 200-file named run among them (#2935)", () => {
		expect(ask(20_000, 1, NAMED_200)).toBeNull();
		expect(ask(20_000, 1, NAMED_200, { weight: TOUCHED_200 })).toBeNull();
		expect(ask(20_000, 1, [], { weight: weighed(200) })).toEqual({
			limb: "count",
		});
	});

	it("still holds a touched run on the memory rung for its file count (#2935)", () => {
		expect(ask(1649, 0, NAMED_200, { weight: TOUCHED_200 })).toMatchObject({
			limb: "memory",
			rungMb: suiteRungMb(WHOLE_SUITE_WORKERS),
		});
		expect(ask(1649, 0, ["scripts/a.test.ts"], { weight: weighed(1) })).toEqual(
			{
				limb: "memory",
				mb: 1649,
				rungMb: 1650,
			},
		);
	});

	it("reads an open gate as null", () => {
		expect(ask(20_000, 0)).toBeNull();
	});

	it("judges on through an unreadable config, as the guard does", () => {
		expect(ask(500, 0, [], { config: "{" })).toMatchObject({ limb: "memory" });
	});

	it("lets a one-file run's poll through at 1,650 MB, where a whole suite's is held", () => {
		expect(ask(1650, 0, ["scripts/a.test.ts"])).toBeNull();
		expect(ask(1649, 0, ["scripts/a.test.ts"])).toEqual({
			limb: "memory",
			mb: 1649,
			rungMb: 1650,
		});
		expect(ask(1650, 0)).toMatchObject({
			limb: "memory",
			rungMb: suiteRungMb(WHOLE_SUITE_WORKERS),
		});
	});
});

describe("the Windows-memory hold, against the real gate (#4557)", () => {
	const { readGate } = require("./suite-concurrency-host.js");

	const waitOn = async (
		first: number,
		frees: number[],
		{
			timeoutMs = 60_000,
			turnShutAt,
			pollMs,
		}: { timeoutMs?: number; turnShutAt?: number; pollMs?: number } = {},
	) => {
		const dir = qdir();
		const meminfo = path.join(dir, "meminfo");
		fs.writeFileSync(meminfo, `MemAvailable: ${20_000 * 1024} kB\n`);
		vi.stubEnv("WFC_MEMINFO", meminfo);
		vi.stubEnv("WFC_PS", writePsStub(dir, []));
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "config"));
		const log = path.join(dir, "memwatch-minute.jsonl");
		vi.stubEnv("MEMWATCH_MINUTE_LOG", log);
		let last = first;
		const write = (mb: number) => {
			last = mb;
			fs.appendFileSync(
				log,
				`${JSON.stringify({ ts: new Date().toISOString(), win_avail_mb: mb, win_age_s: 5 })}\n`,
			);
		};
		write(first);
		const said: string[] = [];
		let clock = 0;
		let exitHeld: object | undefined;
		const outcome = await waitForGate({
			gate: (climbMb: number) =>
				gateDenies(
					[],
					(command: string, carried: null, climb: number) =>
						readGate(command, dir, {
							weight: carried,
							climbMb: climb,
							allClimbMb: () => climb,
							gateSeats: noSeats,
						}),
					null,
					{ climbMb },
				),
			admit: noQueue,
			timeoutMs,
			pollMs,
			...(turnShutAt === undefined ? {} : { turn: () => last !== turnShutAt }),
			monoClock: () => clock,
			sleepFn: (ms: number) => {
				clock += ms;
				const next = frees.shift();
				if (next !== undefined) write(next);
				return Promise.resolve();
			},
			traceLimbs: true,
			out: { write: (s: string) => said.push(s) },
			onExit: (_reason: string, _ms: number, heldBy?: object) => {
				exitHeld = heldBy;
			},
		});
		return { outcome, said: said.join(""), exitHeld };
	};

	it("holds a suite launch while Windows is under its floor, and admits it once Windows clears", async () => {
		const { outcome, said } = await waitOn(700, [749, 750]);
		expect(outcome).toBe("run");
		expect(said).toContain(
			"held on the Windows-memory hold, Windows itself has 700 MB free (memwatch's win_avail_mb), under its 750 MB floor",
		);
		expect(said).toMatch(
			/gate opened after 20s — held 20s on the Windows-memory hold/,
		);
	});

	it("refuses at a bound short of the maximum hold, not run, where Windows never clears", async () => {
		const { outcome, said } = await waitOn(700, [700, 700], {
			timeoutMs: 20_000,
		});
		expect(outcome).toBe("refused");
		expect(said).toContain(
			"the Windows-memory hold still holds after 20s (Windows itself has 700 MB free (memwatch's win_avail_mb), under its 750 MB floor) — refused, not run.",
		);
	});

	// guess: each poll spawns a ps at ~100 ms, #5036
	const minutePolls = 60_000;

	it("runs a wait one spell of the hold has held for its 10-minute maximum, saying so and logging it (#4850)", async () => {
		const { outcome, said, exitHeld } = await waitOn(700, [], {
			timeoutMs: 30 * 60_000,
			pollMs: minutePolls,
		});
		expect(outcome).toBe("run");
		expect(exitHeld).toMatchObject({ windowsReleased: true });
		expect(said.match(/released this wait/g)).toHaveLength(1);
		expect(said).toContain(
			"the Windows-memory hold released this wait after 600s, its 10-minute maximum (Windows itself has 700 MB free (memwatch's win_avail_mb), under its 750 MB floor) (#4850)",
		);
	});

	it("starts the maximum afresh once Windows clears between spells (#4850)", async () => {
		const spell = new Array(480_000 / minutePolls).fill(700);
		const { outcome, said, exitHeld } = await waitOn(
			700,
			[...spell, 1500, ...spell, 1500, ...spell],
			{ timeoutMs: 20 * 60_000, turnShutAt: 1500, pollMs: minutePolls },
		);
		expect(said).not.toContain("released this wait");
		expect(outcome).toBe("refused");
		expect(exitHeld).not.toHaveProperty("windowsReleased");
	});
});

describe("queueSeat, one seat's lifecycle end to end (#4240)", () => {
	const markersIn = (dir: string) =>
		fs.readdirSync(dir).filter((f) => f.startsWith("wfc-suite-queue-"));
	const recordIn = (dir: string) =>
		JSON.parse(
			fs.readFileSync(path.join(dir, markersIn(dir)[0] as string), "utf8"),
		);
	const never = () => new Promise<void>(noop);
	const seatIn = (dir: string, seatOptions: object = {}) => {
		const lines: { reason: string; extra?: object }[] = [];
		const seat = queueSeat({
			queue: { queueDir: dir, alive: () => true },
			logExit: (reason: string, _ms: number, extra?: object) =>
				lines.push({ reason, extra }),
			...seatOptions,
		});
		return { seat, lines };
	};
	const quiet = { out: { write: () => true } };

	it("joins before the wait reads anything, and holds the marker past an opened wait until it leaves", async () => {
		const dir = qdir();
		const { seat, lines } = seatIn(dir);
		const seen: number[] = [];
		const outcome = await seat.wait({
			...quiet,
			gate: () => {
				seen.push(markersIn(dir).length);
				return null;
			},
		});
		expect(outcome).toBe("run");
		expect(seen).toEqual([1]);
		expect(recordIn(dir).admitted).toBe(true);
		expect(recordIn(dir).spawned).toBeUndefined();
		seat.spawned();
		expect(recordIn(dir).spawned).toBe(true);
		seat.leave();
		seat.leave();
		expect(markersIn(dir)).toEqual([]);
		expect(lines.map((l) => l.reason)).toEqual(["opened"]);
	});

	it("puts the older part-suites its default turn passed on the exit line (#3115)", async () => {
		const dir = qdir();
		fs.writeFileSync(
			path.join(dir, "wfc-suite-queue-1.json"),
			JSON.stringify({
				pid: 1,
				at: Date.now() - 1000,
				part: true,
				memoryHeld: true,
			}),
		);
		const { seat, lines } = seatIn(dir, { join: { weight: PART } });
		await seat.wait({ ...quiet, gate: () => null });
		seat.leave();
		expect(lines).toEqual([{ reason: "opened", extra: { passed: 1 } }]);
	});

	it.each([
		{
			ends: "a refusal",
			wait: { gate: () => ({ limb: "memory" }), timeoutMs: -1 },
			outcome: "refused",
		},
		{
			ends: "a leave",
			wait: { gate: () => ({ limb: "count" }), leave: () => "HEAD" },
			outcome: "left",
		},
	])(
		"leaves on $ends without the caller's leave",
		async ({ wait, outcome }) => {
			const dir = qdir();
			const { seat, lines } = seatIn(dir);
			expect(await seat.wait({ ...quiet, ...wait })).toBe(outcome);
			expect(markersIn(dir)).toEqual([]);
			expect(lines.map((l) => l.reason)).toEqual([outcome]);
		},
	);

	it("leaves on a throw, and rethrows it", async () => {
		const dir = qdir();
		const { seat } = seatIn(dir);
		await expect(
			seat.wait({
				...quiet,
				gate: () => {
					throw new Error("gate broke");
				},
			}),
		).rejects.toThrow("gate broke");
		expect(markersIn(dir)).toEqual([]);
	});

	it("takes no marker with `join: false` (#3404)", async () => {
		const dir = qdir();
		const { seat } = seatIn(dir, { join: false });
		expect(seat.ticket).toBe("");
		expect(markersIn(dir)).toEqual([]);
	});

	describe("on a signal (mantahostels#2034)", () => {
		const host = () => {
			const emitter = new EventEmitter();
			const exits: number[] = [];
			return { emitter, exits, exit: (code: number) => exits.push(code) };
		};

		it("leaves, writes one `killed` line and exits on a signal while waiting", async () => {
			const dir = qdir();
			const h = host();
			const { seat, lines } = seatIn(dir, {
				signals: { emitter: h.emitter, exit: h.exit },
			});
			seat.wait({ ...quiet, gate: () => ({ limb: "count" }), sleepFn: never });
			await Promise.resolve();
			expect(markersIn(dir)).toHaveLength(1);
			h.emitter.emit("SIGINT");
			expect(markersIn(dir)).toEqual([]);
			expect(h.exits).toEqual([130]);
			expect(lines).toEqual([
				{ reason: "killed", extra: { signal: "SIGINT" } },
			]);
			h.emitter.emit("SIGTERM");
			expect(lines).toHaveLength(1);
		});

		it("leaves with no `killed` line once the wait has ended", async () => {
			const dir = qdir();
			const h = host();
			const { seat, lines } = seatIn(dir, {
				signals: { emitter: h.emitter, exit: h.exit },
			});
			await seat.wait({ ...quiet, gate: () => null });
			h.emitter.emit("SIGTERM");
			expect(markersIn(dir)).toEqual([]);
			expect(h.exits).toEqual([143]);
			expect(lines.map((l) => l.reason)).toEqual(["opened"]);
		});

		it("keeps the marker and does not exit where `onSignal` handled it", async () => {
			const dir = qdir();
			const h = host();
			const handled: string[] = [];
			const { seat } = seatIn(dir, {
				signals: {
					emitter: h.emitter,
					exit: h.exit,
					onSignal: (signal: string) => handled.push(signal) > 0,
				},
			});
			await seat.wait({ ...quiet, gate: () => null });
			h.emitter.emit("SIGHUP");
			expect(handled).toEqual(["SIGHUP"]);
			expect(h.exits).toEqual([]);
			expect(markersIn(dir)).toHaveLength(1);
			seat.leave();
			h.emitter.emit("SIGTERM");
			expect(handled).toEqual(["SIGHUP", "SIGTERM"]);
			expect(h.exits).toEqual([]);
		});

		it("never asks `onSignal` while the seat still waits", async () => {
			const dir = qdir();
			const h = host();
			const handled: string[] = [];
			const { seat, lines } = seatIn(dir, {
				signals: {
					emitter: h.emitter,
					exit: h.exit,
					onSignal: (signal: string) => handled.push(signal) > 0,
				},
			});
			seat.wait({ ...quiet, gate: () => ({ limb: "count" }), sleepFn: never });
			await Promise.resolve();
			h.emitter.emit("SIGTERM");
			expect(handled).toEqual([]);
			expect(h.exits).toEqual([143]);
			expect(lines.map((l) => l.reason)).toEqual(["killed"]);
		});

		it("writes the `killed` line, then runs the cleanups, then leaves", async () => {
			const dir = qdir();
			const h = host();
			const order: string[] = [];
			armSeatSignals({
				emitter: h.emitter,
				exit: (c: number) => order.push(`exit ${c}`),
				cleanup: () => order.push(`cleanup, ${markersIn(dir).length} marker`),
			});
			const seat = queueSeat({
				queue: { queueDir: dir, alive: () => true },
				logExit: (reason: string) => order.push(reason),
				signals: { emitter: h.emitter },
			});
			seat.wait({ ...quiet, gate: () => ({ limb: "count" }), sleepFn: never });
			await Promise.resolve();
			h.emitter.emit("SIGINT");
			expect(order).toEqual(["killed", "cleanup, 1 marker", "exit 130"]);
			expect(markersIn(dir)).toEqual([]);
		});

		it("arms each emitter once, running every cleanup before the exit", () => {
			const h = host();
			const order: string[] = [];
			const cleanup = () => order.push("cleanup");
			armSeatSignals({
				emitter: h.emitter,
				exit: (c: number) => order.push(`exit ${c}`),
				cleanup,
			});
			armSeatSignals({ emitter: h.emitter, cleanup });
			expect(h.emitter.listenerCount("SIGTERM")).toBe(1);
			h.emitter.emit("SIGTERM");
			expect(order).toEqual(["cleanup", "exit 143"]);
		});

		it("arms nothing for a seat that does not opt in", () => {
			const dir = qdir();
			const before = process.listenerCount("SIGTERM");
			const { seat } = seatIn(dir);
			expect(process.listenerCount("SIGTERM")).toBe(before);
			seat.leave();
		});
	});
});

describe("each session holds at most two places in each queue (#5595)", () => {
	const S = "fan-out-session";
	const T = "other-session";
	const root = () => qdir();
	const exits = new Map<ReturnType<typeof queueSeat>, object>();
	const seat = (
		queueDir: string,
		pid: number,
		at: number | (() => number),
		join: object = {},
	) => {
		const clock = typeof at === "function" ? at : () => at;
		const made: ReturnType<typeof queueSeat> = queueSeat({
			queue: { queueDir, pid, clock, alive: () => true },
			join: { env: {}, ...join },
			logExit: (reason: string, _ms: number, extra: object) =>
				exits.set(made, { reason, ...extra }),
		});
		return made;
	};
	const running = (queueDir: string, pid: number, at: number, session = S) => {
		const s = seat(queueDir, pid, at, {
			session,
			weight: PART,
			kind: "touched",
		});
		s.spawned();
		return s;
	};
	async function waited(s: ReturnType<typeof queueSeat>, wait: object = {}) {
		let said = "";
		await s.wait({
			gate: () => null,
			timeoutMs: 0,
			sleepFn: () => Promise.resolve(),
			out: {
				write: (t: string) => {
					said += t;
					return true;
				},
			},
			...wait,
		});
		return {
			exit: exits.get(s) as {
				reason: string;
				limb?: string;
				sessionCapS?: number;
			},
			said,
		};
	}
	const partWaiter = (queueDir: string, pid: number, at: number, session = S) =>
		seat(queueDir, pid, at, { session, weight: PART, kind: "touched" });
	const marker = (s: ReturnType<typeof queueSeat>) =>
		JSON.parse(fs.readFileSync(s.ticket, "utf8"));

	it("holds a third waiter out of the shared queue, so another session's later waiter opens ahead of it", async () => {
		const queueDir = path.join(root(), "wfc-suite-queue");
		running(queueDir, 11, 100);
		running(queueDir, 12, 200);
		const third = partWaiter(queueDir, 13, 300);
		const later = partWaiter(queueDir, 21, 400, T);
		expect((await waited(later)).exit.reason).toBe("opened");
		const held = await waited(third);
		expect(held.exit).toMatchObject({ reason: "refused", limb: "session-cap" });
	});

	it("lets the over-cap waiters into the queue as places free, oldest first", () => {
		const queueDir = path.join(root(), "wfc-suite-queue");
		const first = running(queueDir, 11, 100);
		running(queueDir, 12, 200);
		const third = partWaiter(queueDir, 13, 300);
		const fourth = partWaiter(queueDir, 14, 350);
		expect(third.stamps.sessionCap()).toMatchObject({ limb: "session-cap" });
		first.leave();
		expect(third.stamps.sessionCap()).toBeNull();
		expect(fourth.stamps.sessionCap()).toMatchObject({ limb: "session-cap" });
		expect(marker(third).enteredAt).toBe(300);
	});

	it("queues the entered waiter behind a later-joined waiter of another session", async () => {
		const queueDir = path.join(root(), "wfc-suite-queue");
		let now = 300;
		const first = running(queueDir, 11, 100);
		running(queueDir, 12, 200);
		const third = seat(queueDir, 13, () => now, {
			session: S,
			weight: PART,
			kind: "touched",
		});
		partWaiter(queueDir, 21, 320, T);
		expect(third.stamps.sessionCap()).not.toBeNull();
		first.leave();
		now = 500;
		expect(third.stamps.sessionCap()).toBeNull();
		expect(marker(third).enteredAt).toBe(500);
		expect(await turnOpen({ queueDir, pid: 13 })).toBe(false);
	});

	it("counts the held wait toward the wait bound from the ask, and names the session's places at the refusal", async () => {
		const queueDir = path.join(root(), "wfc-suite-queue");
		running(queueDir, 11, 100);
		seat(queueDir, 12, 200, { session: S });
		const third = partWaiter(queueDir, 13, 300);
		let t = 0;
		const { exit, said } = await waited(third, {
			timeoutMs: 5000,
			monoClock: () => {
				t += 1000;
				return t;
			},
		});
		expect(exit).toMatchObject({ reason: "refused", limb: "session-cap" });
		expect(exit.sessionCapS).toBeGreaterThanOrEqual(4);
		expect(said).toContain("this session's own 2 places");
		expect(said).toContain("PID 11 (part, running), PID 12 (whole, waiting)");
	});

	it("caps the `tsc` queue and the suite queue separately", () => {
		const base = root();
		const suiteDir = path.join(base, "wfc-suite-queue");
		const tscDir = path.join(base, "wfc-tsc-queue");
		running(suiteDir, 11, 100);
		running(suiteDir, 12, 200);
		const tsc = seat(tscDir, 13, 300, { session: S });
		expect(tsc.stamps.sessionCap()).toBeNull();
		seat(tscDir, 14, 400, { session: S });
		const thirdTsc = seat(tscDir, 15, 500, { session: S });
		expect(thirdTsc.stamps.sessionCap()).toEqual({
			limb: "session-cap",
			places: [
				{ pid: 13, kind: "tsc", state: "waiting" },
				{ pid: 14, kind: "tsc", state: "waiting" },
			],
		});
	});

	it("holds no waiter in the other queue on an over-cap waiter's climb stamp, until it enters", async () => {
		const base = root();
		const suiteDir = path.join(base, "wfc-suite-queue");
		const tscDir = path.join(base, "wfc-tsc-queue");
		running(suiteDir, 11, 100);
		const second = partWaiter(suiteDir, 12, 200);
		const third = partWaiter(suiteDir, 13, 300);
		third.stamps.onClimbStamp(true);
		seat(tscDir, 21, 400, { session: T });
		expect(await turnOpen({ queueDir: tscDir, pid: 21 })).toBe(true);
		second.leave();
		expect(await turnOpen({ queueDir: tscDir, pid: 21 })).toBe(false);
	});

	it("caps no waiter without a session id, and none a lander run joins", () => {
		const queueDir = path.join(root(), "wfc-suite-queue");
		running(queueDir, 11, 100);
		running(queueDir, 12, 200);
		const lander = seat(queueDir, 13, 300, {
			session: S,
			env: { WFC_LANDER_RUN: "1" },
		});
		expect(marker(lander).session).toBeUndefined();
		expect(lander.stamps.sessionCap()).toBeNull();
		for (const pid of [21, 22, 23]) seat(queueDir, pid, 400 + pid);
		expect(seat(queueDir, 24, 500).stamps.sessionCap()).toBeNull();
	});
});
