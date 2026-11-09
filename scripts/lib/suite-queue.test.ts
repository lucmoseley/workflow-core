// @vitest-environment node
/*
 * `npm run test -- --queue`'s wait: the turn order between waiters, the gate
 * poll, and the `(pid, start)` staleness rule and marker walk shared between
 * `readTurn` (which sweeps a stale marker on sight) and
 * check-stale-suite-queue.js (which only reports one). Neither caller tests the
 * rule itself, so a staleness case broken here fails nowhere else
 * (mantahostels#2034).
 *
 * `gateDenies`' limb cases read the real gate in process
 * (lib/suite-concurrency-host.js's `readGate`), its memory and `ps` staged at
 * its own seams, since the limb is the guard's core's to name.
 * Liveness and start time are injected as plain functions, so pid reuse can be
 * staged without a real reused pid; of the staleness cases only `readStartTimeOf`
 * reads a real process.
 * The turn's rule is pure (`turnOf`), so its cases pass values; `readTurn`'s
 * cases write real markers into a temp directory of their own and read them
 * through a seat.
 * That a KILLED waiter drops its marker is the seat's signal handler, its
 * signals emitted on an injected emitter; run-vitest.js's real process tests
 * the exit it takes on a real one.
 * In the world, a wrong verdict lets `npm run test -- --queue` sweep a live
 * suite's marker and start past it on the memory-capped machine, or wait
 * behind a dead one.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suiteRungMb, WHOLE_SUITE_WORKERS } from "./admission.js";
import { mkScratchDir } from "./git-fixture";
import { writePsStub } from "./ps-stub";
import { runInProcess } from "./run-in-process.js";
import { TSC_PEAK_MB, tscDenial } from "./tsc-slot";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

const {
	isMarkerStale,
	readMarkers,
	readStartTimeOf,
	PART_PASS_AGE_MS,
	turnOf,
	readLiveRoleMarkers,
	readQueuesClimbMb,
	gateDenies,
	heldSeat,
	SEAT_ENV,
	waitForGate,
	queueSeat,
	armSeatSignals,
} = require("./suite-queue.js");
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

/** A launch's carried weight at `files` resolved test files (#2931). */
const weighed = (files: number | null) => ({
	resolvedFiles: files,
	wholeSlot: !weighFiles(files).part,
});
/** A part-suite's carried weight. */
const PART = weighed(2);
/** A 200-file named run: past the whole-slot bound, still a touched run. */
const NAMED_200 = Array.from(
	{ length: 200 },
	(_, i) => `scripts/t${i}.test.ts`,
);
/** The weight run-vitest.js carries for a touched run, which takes no slot. */
const TOUCHED_200 = { resolvedFiles: 200, wholeSlot: false };

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** `waitForGate`'s admission for a wait with no queue to stamp (#2742). */
const noQueue = () => "admitted" as const;

/** A queue directory of its own, cleaned up after each case. */
function qdir() {
	const d = mkScratchDir("queue-");
	dirs.push(d);
	return d;
}

/** `pid`'s seat in `queueDir`, its marker joined at `at`. */
const joined = (queueDir: string, pid: number, at: number, join: object = {}) =>
	queueSeat({
		queue: { queueDir, pid, clock: () => at, alive: () => true },
		join,
	});

/** A seat's stamps where it joins no marker: what its wait charges and admits. */
const seatStamps = (queue: object) => queueSeat({ queue, join: false }).stamps;

/**
 * One poll of `pid`'s turn on an open gate, by a seat that joins no marker of
 * its own, so the read writes, stamps and removes none: its exit line's
 * reason and fields.
 */
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

/** Whether `pid`'s turn is open, read as `polled` reads it. */
const turnOpen = async (queue: Parameters<typeof polled>[0] = {}) =>
	((await polled(queue)) as { reason: string }).reason === "opened";

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

	/* start: 0 means procfs could not be read when the marker was written —
	 * judged the same way as absent, never as "definitely reused". */
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
	/** A stand-in for `fs`, typed as the slice readMarkers actually calls. */
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

	/* readTurn orders on a numeric `at`, so the walk it shares with
	 * check-stale-suite-queue.js skips a marker without one: one answer to
	 * "does this marker count at all", not just to "is it stale"
	 * (mantahostels#2034). */
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
	/* A reader restating the temp root reads none of this queue. */
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
			readLiveRoleMarkers("lander").map((m: { pid: number }) => m.pid),
		).toEqual([process.pid]);
		expect(readLiveLanders().map((l: { pid: number }) => l.pid)).toEqual([
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
		).toMatchObject([{ pid: 11, role: "lander", chargeMb: 600 }]);
		expect(fs.readdirSync(queueDir)).toHaveLength(3);
	});
});

describe("heldSeat, a mutation loop's one seat (#2918)", () => {
	/* 40 → 30 → 20 → 10: the run is 40, its driver 30, the seat 20. */
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
		spawned?: boolean;
		memoryHeld?: boolean;
	}
	const turn = (
		{
			waiter = "whole" as "whole" | "part" | "tsc",
			ahead = [] as Ahead[],
			admissionOpen = false,
			slots = WHOLE_SUITE_MAX,
			now = 1000,
		} = {},
		options?: { partPass?: boolean },
	) => turnOf({ waiter, ahead, admissionOpen, slots, now }, options);
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
			/* The gate counts `ps`, so two waiters admitted before either is
			 * visible would both read the same free slot (#601). */
			expect(reasons({ ahead: [wholeAhead], slots: 2 })).toEqual([
				"fifo-whole",
			]);
		});

		// #2680's cap: one whole suite at a time.
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
	});

	it("holds a `tsc` behind its own queue's older waiter, named as its own limb (#3163)", () => {
		expect(reasons({ waiter: "tsc", ahead: [wholeAhead] })).toEqual([
			"tsc-fifo",
		]);
	});

	/* An admitted launch is not yet in `ps`, so every other waiter, ahead or
	 * behind, waits it out (#601). */
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
	/** Everything alive except the pids named. */
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

		/* An admission yielded on the same poll, so the next poll reads the
		 * gate denying and never the turn: the pass it counted is stale. */
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

	describe("a part-suite by the weight its seat joined with (#2931)", () => {
		/** A whole suite 11 running, and 99 joined behind it at `weight`. */
		const besideRunning = (weight?: object) => {
			const queueDir = qdir();
			joined(queueDir, 11, 11).spawned();
			joined(queueDir, 99, 99, weight ? { weight } : {});
			return turnOpen({ queueDir, pid: 99 });
		};

		/* The line is WHOLE_SLOT_BOUND, never the whole suite's worker count. */
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
			/* `--changed`'s plan selected 40 files; its argv names none. */
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

	it("steps over a dead waiter's marker, and sweeps it", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		joined(queueDir, 22, 200);
		expect(await turnOpen({ queueDir, pid: 22, alive: deadOnly(11) })).toBe(
			true,
		);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-22.json"]);
	});

	/* Markers are read in directory order, which is lexicographic, so
	 * `…-100.json` is read before `…-9.json`, and without the tie-break the
	 * first one read wins (mantahostels#2024). */
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

	/* A leaked marker whose pid is later reused by an unrelated process
	 * (mantahostels#2034). */
	it("treats a reused pid as stale, even though it is alive", async () => {
		const queueDir = qdir();
		const mine = joined(queueDir, 11, 100);
		// A marker claiming a start time that the live process does not have.
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-12.json"),
			JSON.stringify({ pid: 12, at: 50, start: 999_999_999 }),
		);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(true);
		expect(fs.readdirSync(queueDir)).toEqual([path.basename(mine.ticket)]);
	});

	/* Markers written before mantahostels#2034 carry no start time, and procfs may not be
	 * readable at all. Neither may be read as "stale" — that would sweep live
	 * waiters. */
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

	/* A start of 0 is what a seat's join writes when procfs cannot be read.
	 * Without the `> 0` guard the comparison runs against a real start time,
	 * never matches, and every such waiter is swept as stale. */
	it("falls back to liveness when a marker records a start time of 0", async () => {
		const queueDir = qdir();
		joined(queueDir, 11, 100);
		/* THIS process's pid, so `readStartTimeOf` returns a real, non-zero tick
		 * count. A pid with no readable /proc entry returns 0 on both sides of
		 * the comparison (mantahostels#2034). */
		fs.writeFileSync(
			path.join(queueDir, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 50, start: 0 }),
		);
		expect(await turnOpen({ queueDir, pid: 11 })).toBe(false);
		expect(fs.readdirSync(queueDir)).toHaveLength(2);
	});

	/* The stampede itself: an open gate is not enough to launch on. */
	it("keeps waiting on an open gate while it is not this waiter's turn", async () => {
		let turns = 3;
		const sleepFn = vi.fn(() => Promise.resolve());
		await waitForGate({
			gate: () => false,
			turn: () => turns-- <= 0,
			admit: noQueue,
			sleepFn,
			out: { write: () => true },
		});
		expect(sleepFn).toHaveBeenCalledTimes(3);
	});
});

describe("two launches whose turns came true on one poll (#2622)", () => {
	type Seat = ReturnType<typeof queueSeat>;
	const alive = () => true;
	const admitted = (seat: Seat) =>
		JSON.parse(fs.readFileSync(seat.ticket, "utf8")).admitted === true;
	/** Stamp `seat` admitted as its own admission would, before its re-read. */
	const stamp = (seat: Seat) => {
		const record = JSON.parse(fs.readFileSync(seat.ticket, "utf8"));
		fs.writeFileSync(
			seat.ticket,
			JSON.stringify({ ...record, admitted: true }),
		);
	};

	/** Two joined seats, 11 ahead of 22, 22 joining with `join22`. `hooked`'s
	 * queue fs runs `between` before every directory read: inside its
	 * admission, between its stamp and its re-read. */
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

	/* A whole suite and the part-suite backfilling behind it, freed on one
	 * poll, with a load hold between each turn and its launch: the re-read
	 * after the hold settles it, so the admission's contest (pinned above) is
	 * never reached. A launch spawns once its rival next sleeps. */
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
	/** The suite queue and the type-check slot's, siblings as under the
	 * temp root, with a whole suite 11 waiting in one and a `tsc` 22 in the
	 * other. `hooked`'s queue fs runs `between` before every directory read. */
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
		expect(lines[2]).toMatch(
			/^q: gate opened after \d+s — held \d+s on a launch admitted and not yet up\n$/,
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

	/* Both gates open on one poll, each wait with its own load hold: one
	 * launches and the other is held until it spawns. A launch spawns once
	 * its rival next sleeps. */
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
	/** Both queues as siblings under one root, as under the temp root. */
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
		tsc.stamps.onClimbHolds(true);
		expect(await suiteTurn()).toBe(false);
		tsc.spawned();
		expect(await suiteTurn()).toBe(true);
	});

	it("releases the suite once the climb no longer holds the `tsc`", async () => {
		const { suiteDir, tscDir } = both();
		const tsc = joined(tscDir, 22, 5);
		joined(suiteDir, 11, 10);
		tsc.stamps.onClimbHolds(true);
		tsc.stamps.onClimbHolds(false);
		expect(JSON.parse(fs.readFileSync(tsc.ticket, "utf8")).climbHeld).toBe(
			undefined,
		);
		expect(await turnOpen({ queueDir: suiteDir, pid: 11 })).toBe(true);
	});

	it("never holds a waiter behind a younger peer, so the oldest never yields", async () => {
		const { suiteDir, tscDir } = both();
		joined(tscDir, 22, 20).stamps.onClimbHolds(true);
		joined(suiteDir, 11, 10).stamps.onClimbHolds(true);
		expect(await turnOpen({ queueDir: suiteDir, pid: 11 })).toBe(true);
		expect(await turnOpen({ queueDir: tscDir, pid: 22 })).toBe(false);
	});

	it("names the peer that holds a traced wait", async () => {
		const { suiteDir, tscDir } = both();
		const tsc = joined(tscDir, 22, 5);
		tsc.stamps.onClimbHolds(true);
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

	it("stamps a wait the climb alone holds, never one MemAvailable itself fails", async () => {
		const heard: boolean[] = [];
		const polls = [
			{ limb: "memory", mb: 3000, rungMb: 2750, climbMb: 500 },
			{ limb: "memory", mb: 2000, rungMb: 2750, climbMb: 500 },
			{ limb: "memory", mb: 3000, rungMb: 2750, climbMb: 500 },
		];
		await waitForGate({
			gate: () => polls.shift() ?? null,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onClimbHolds: (held: boolean) => heard.push(held),
		});
		expect(heard).toEqual([true, false, true, false]);
	});
});

describe("a launch still climbing, on the other queue's rung (#3416)", () => {
	const alive = () => true;
	/** A process table holding no runner: the machine's own are no fixture's. */
	const noRunners = () => ({
		ok: true as const,
		rows: [{ pid: 1, args: "/sbin/init" }],
	});
	/** A suite's gate on a `tsc` climbing to 1,000 MB over three polls, the
	 * third freeing 700 MB: MemAvailable reads 6,500 MB less what the `tsc` has
	 * drawn, against a 5,000 MB rung, so a live reading alone admits at once. */
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
	/** Sibling suite and type-check queues, as under the temp root. */
	const queues = () => {
		const root = qdir();
		return {
			suiteDir: path.join(root, "wfc-suite-queue"),
			tscDir: path.join(root, "wfc-tsc-queue"),
		};
	};
	/** A launch `pid` in `queueDir`, admitted and spawned. */
	const spawnedIn = (queueDir: string, pid: number) => {
		const seat = joined(queueDir, pid, 0);
		seat.spawned();
		return seat;
	};
	/** What `queueDir`'s waiter reads its peers have yet to draw, each
	 * peer's tree reading `mb`. */
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

	it("charges a spawned `tsc` its 1,638 MB peak less its tree, never below 0", () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(tscDir, 22);
		expect(climbOf(suiteDir, 400)).toBe(1238);
		expect(climbOf(suiteDir, 1700)).toBe(0);
	});

	it("charges a spawned suite its measured 2,248 MB peak less its tree", () => {
		const { suiteDir, tscDir } = queues();
		spawnedIn(suiteDir, 11);
		expect(climbOf(tscDir, 100)).toBe(2148);
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
		expect(climbOf(tscDir, 100)).toBe(458);
		partIn(suiteDir, 12, 40);
		expect(climbOf(tscDir, 100)).toBe(458 + 1275);
	});

	it("never charges a part-suite above a whole suite's peak", () => {
		const { suiteDir, tscDir } = queues();
		partIn(suiteDir, 11, 500);
		expect(climbOf(tscDir, 100)).toBe(2148);
	});

	it("charges a lander marker the charge it carries (#3973)", () => {
		const { suiteDir, tscDir } = queues();
		joined(suiteDir, 11, 0, { role: "lander", chargeMb: 940 }).spawned();
		expect(climbOf(tscDir, 100)).toBe(840);
	});

	it("charges a lander marker carrying 2,630 MB above a whole suite's peak (#3973)", () => {
		const { suiteDir, tscDir } = queues();
		joined(suiteDir, 11, 0, { role: "lander", chargeMb: 2630 }).spawned();
		expect(climbOf(tscDir, 100)).toBe(2530);
	});

	it("charges a lander marker carrying no charge its queue's peak", () => {
		const { suiteDir, tscDir } = queues();
		joined(suiteDir, 11, 0, { role: "lander" }).spawned();
		expect(climbOf(tscDir, 100)).toBe(2148);
	});

	it("charges a part marker with no file count its queue's peak", () => {
		const { suiteDir, tscDir } = queues();
		partIn(suiteDir, 11, null);
		expect(climbOf(tscDir, 100)).toBe(2148);
	});

	/* 4,000 MB available against the 2,750 MB `tsc` rung, each launch's tree at
	 * 500 MB. */
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
		expect(beside.exits[0][2]).toEqual({ limb: "memory", climbMb: 1748 });
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
		expect(readQueuesClimbMb("all", options)).toBe(2148 + 1538);
		/* A spawned suite not yet on `ps` is on no rung (#4111). */
		expect(readQueuesClimbMb("off-rung", options)).toBe(2148 + 1538);
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
		/** A process table of `pid: args`, with its parents. */
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
			expect(climbOn(tscDir, m)).toBe(2248 - 400);
			vi.stubEnv("TMPDIR", path.dirname(suiteDir));
			expect(readQueuesClimbMb("all", m)).toBe(TSC_PEAK_MB - 400 + 2248 - 400);
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
				).toBe(150 + 2 * 75);
				const m = { ...machine({ 33: "pytest -n 8" }), treePssKb: () => 0 };
				expect(climbOn(tscDir, m)).toBe(150 + 8 * 75);
				expect(climbOn(suiteDir, m)).toBe(0);
				vi.stubEnv("TMPDIR", path.dirname(suiteDir));
				expect(readQueuesClimbMb("off-rung", m)).toBe(0);
				expect(readQueuesClimbMb("all", m)).toBe(150 + 8 * 75);
			});

			it("reads `-n auto` as a worker a CPU, and no `-n` as none", () => {
				const { tscDir } = queues();
				const at = (args: string) =>
					climbOn(tscDir, { ...machine({ 33: args }), treePssKb: () => 0 });
				expect(at("python3 -m pytest -n auto")).toBe(
					150 + 75 * os.availableParallelism(),
				);
				expect(at("python3 -m pytest --numprocesses=3")).toBe(150 + 3 * 75);
				expect(at("python3 -m pytest -n=4")).toBe(150 + 4 * 75);
				expect(at("python3 -m pytest -n2")).toBe(150 + 2 * 75);
				expect(at("python3 -m pytest -q")).toBe(150);
			});

			it("charges `node --test` its one measured peak", () => {
				const { tscDir } = queues();
				expect(
					climbOn(tscDir, { ...machine({ 33: NodeTest }), treePssKb: () => 0 }),
				).toBe(381);
			});

			it("charges a build at every gate, no rung counting it", () => {
				const { suiteDir, tscDir } = queues();
				const m = machine({ 44: Build });
				expect(climbOn(suiteDir, m)).toBe(979 - 400);
				expect(climbOn(tscDir, m)).toBe(979 - 400);
				vi.stubEnv("TMPDIR", path.dirname(suiteDir));
				expect(readQueuesClimbMb("off-rung", m)).toBe(979 - 400);
				expect(readQueuesClimbMb("all", m)).toBe(979 - 400);
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
			expect(readQueuesClimbMb("all", m)).toBe(TSC_PEAK_MB - 400 + 2248 - 400);
			expect(readQueuesClimbMb("off-rung", m)).toBe(TSC_PEAK_MB - 400);
		});

		it("charges a part-suite its own peak, off its words or its launch record", () => {
			const { tscDir } = queues();
			const named = `${Vitest} scripts/a.test.ts scripts/b.test.ts`;
			expect(climbOn(tscDir, machine({ 33: named }))).toBe(
				380 + 2 * 175 + 2 * 3 - 400,
			);
			expect(
				climbOn(tscDir, {
					...machine({ 33: Vitest }),
					carriedOf: () => ({ resolvedFiles: 4, wholeSlot: false }),
				}),
			).toBe(380 + 4 * 175 + 4 * 3 - 400);
		});

		it("leaves out a runner under a live marker in either queue, charging it once", () => {
			const { suiteDir, tscDir } = queues();
			spawnedIn(tscDir, 40);
			const inSlot = machine({ 22: Tsc }, { 22: 40 });
			expect(climbOn(suiteDir, inSlot)).toBe(TSC_PEAK_MB - 400);
			spawnedIn(suiteDir, 50);
			const underSuite = machine({ 33: Tsc }, { 33: 50 });
			expect(climbOn(tscDir, underSuite)).toBe(2248 - 400);
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

	it("names the charge apart from the reading when the rung refuses at the bound", async () => {
		const said: string[] = [];
		await waitForGate({
			gate: (climbMb: number) => ({
				limb: "memory",
				mb: 3000,
				rungMb: 3250,
				climbMb,
			}),
			climbMb: () => 700,
			timeoutMs: 0,
			admit: noQueue,
			out: { write: (s: string) => said.push(s) },
		});
		expect(said.join("")).toMatch(
			/\(MemAvailable 3000 MB, less 700 MB the other queue's launches have yet to draw, against the ~3250 MB rung\)/,
		);
	});
});

describe("waitForGate's load hold, before the gate's last read (#2622)", () => {
	it("reads the gate and the turn again after the hold, and only then admits", async () => {
		const order: string[] = [];
		const outcome = await waitForGate({
			gate: () => {
				order.push("gate");
				return null;
			},
			turn: () => {
				order.push("turn");
				return true;
			},
			hold: () => {
				order.push("hold");
				return Promise.resolve(true);
			},
			admit: () => {
				order.push("admit");
				return "admitted";
			},
			out: { write: () => true },
		});
		expect(outcome).toBe("run");
		expect(order).toEqual(["gate", "turn", "hold", "gate", "turn", "admit"]);
	});

	it("waits again, and holds again, where the gate closed during the hold", async () => {
		const gates = [null, { limb: "count" }, null, null];
		const hold = vi.fn(() => Promise.resolve(true));
		const sleepFn = vi.fn(() => Promise.resolve());
		const outcome = await waitForGate({
			gate: () => gates.shift() ?? null,
			hold,
			admit: noQueue,
			sleepFn,
			out: { write: () => true },
		});
		expect(outcome).toBe("run");
		expect(sleepFn).toHaveBeenCalledTimes(1);
		expect(hold).toHaveBeenCalledTimes(2);
	});

	it("refuses, admitting nothing, where the hold refuses", async () => {
		const admit = vi.fn(() => "admitted");
		const exits: unknown[] = [];
		const outcome = await waitForGate({
			gate: () => null,
			hold: () => Promise.resolve(false),
			admit,
			onExit: (reason: string) => exits.push(reason),
			out: { write: () => true },
		});
		expect(outcome).toBe("refused");
		expect(exits).toEqual(["refused"]);
		expect(admit).not.toHaveBeenCalled();
	});

	it("re-reads at once after yielding ahead, and after a poll when behind", async () => {
		const sleeps = async (yields: string) => {
			const admissions = [yields, "admitted"];
			const sleepFn = vi.fn(() => Promise.resolve());
			await waitForGate({
				gate: () => null,
				admit: () => admissions.shift(),
				sleepFn,
				out: { write: () => true },
			});
			return sleepFn.mock.calls.length;
		};
		expect([await sleeps("ahead"), await sleeps("behind")]).toEqual([0, 1]);
	});

	/** A part-suite's wait already past its ceiling on the count cap. */
	const atCeiling = (options: object) => {
		const said: string[] = [];
		const outcome = waitForGate({
			timeoutMs: 0,
			part: true,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => said.push(line) },
			...options,
		});
		return { outcome, said };
	};

	it("holds at its ceiling, then reads the gate again before it runs anyway", async () => {
		const order: string[] = [];
		const { outcome, said } = atCeiling({
			gate: () => {
				order.push("gate");
				return { limb: "count" };
			},
			hold: () => {
				order.push("hold");
				return Promise.resolve(true);
			},
			admit: () => {
				order.push("admit");
				return "admitted";
			},
		});
		expect(await outcome).toBe("run");
		expect(order).toEqual(["gate", "hold", "gate", "admit"]);
		expect(said.join("")).toMatch(/running anyway/);
	});

	it("refuses at its ceiling on the memory rung the gate reads after the hold", async () => {
		const gates = [{ limb: "count" }, { limb: "memory", mb: 900 }];
		const { outcome, said } = atCeiling({
			gate: () => gates.shift(),
			hold: () => Promise.resolve(true),
		});
		expect(await outcome).toBe("refused");
		expect(said.join("")).toMatch(/denies on memory/);
	});

	it("yields at its ceiling to another admitted launch, and runs a poll later", async () => {
		const admissions = ["ahead", "admitted"];
		const sleepFn = vi.fn(() => Promise.resolve());
		const { outcome } = atCeiling({
			gate: () => ({ limb: "count" }),
			admit: () => admissions.shift(),
			sleepFn,
		});
		expect(await outcome).toBe("run");
		expect(sleepFn).toHaveBeenCalledTimes(1);
	});
});

describe("waitForGate, the wait itself (mantahostels#2024)", () => {
	it("refuses a wait with no admit before reading the gate (#2742)", () => {
		const gate = vi.fn(() => null);
		expect(() => waitForGate({ gate })).toThrow(/`admit` is required/);
		expect(gate).not.toHaveBeenCalled();
	});

	it("says so when it waited", async () => {
		const lines: string[] = [];
		let closed = 1;
		await waitForGate({
			gate: () => closed-- > 0,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(lines.join("")).toMatch(/waiting for it/);
		expect(lines.join("")).toMatch(/gate opened/);
	});

	describe("tracing the limb that holds it (#4359)", () => {
		/** A wait on `polls`, one a poll, each poll 10 s apart. */
		const traced = async (polls: object[], traceLimbs: boolean) => {
			const lines: string[] = [];
			let now = 0;
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				clock: () => now,
				sleepFn: () => {
					now += 10_000;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs,
			});
			return lines;
		};
		const gates = () => [
			{ limb: "count", pids: [7] },
			{ limb: "count", pids: [7] },
			{ limb: "memory", mb: 2000, rungMb: 2750 },
			{ limb: "memory", mb: 2100, rungMb: 2750, climbMb: 300 },
			{ limb: "count", pids: [8] },
		];

		it("prints each change of limb or holder, never a moving MemAvailable, and the time on each as the gate opens", async () => {
			expect(await traced(gates(), true)).toEqual([
				"q: waiting\n",
				"q: after 0s, held on the count cap, PID 7\n",
				"q: after 20s, held on the memory rung, MemAvailable 2000 MB against ~2750 MB\n",
				"q: after 40s, held on the count cap, PID 8\n",
				"q: gate opened after 50s — held 30s on the count cap, 20s on the memory rung; MemAvailable at lowest 2000 MB\n",
			]);
		});

		it("names every limb failing on the poll, not the gate's first alone", async () => {
			const lines: string[] = [];
			let turns = 0;
			await waitForGate({
				gate: () =>
					turns < 1
						? { limb: "count", pids: [7], memory: { mb: 2000, rungMb: 2750 } }
						: null,
				turn: () => turns++ > 0,
				admit: noQueue,
				sleepFn: () => Promise.resolve(),
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines[1]).toBe(
				"q: after 0s, held on the count cap, PID 7; also on the memory rung, MemAvailable 2000 MB against ~2750 MB; also on the queue's turn\n",
			);
		});

		it("rounds the breakdown so its parts sum to the whole", async () => {
			const lines: string[] = [];
			let now = 0;
			const polls: object[] = [{ limb: "count" }, { limb: "memory" }];
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				clock: () => now,
				sleepFn: () => {
					now += 1500;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.at(-1)).toBe(
				"q: gate opened after 3s — held 2s on the count cap, 1s on the memory rung\n",
			);
		});

		it("sums the parts to the printed whole where the float sum would not, counting the first stretch to its limb", async () => {
			const lines: string[] = [];
			let now = 0;
			const steps = [1003, 2377];
			const polls: object[] = [
				{ limb: "count" },
				{ limb: "memory" },
				{ limb: "count", pids: [9] },
			];
			await waitForGate({
				gate: () => {
					if (now === 0) now = 120;
					return polls.shift() ?? null;
				},
				admit: noQueue,
				clock: () => now,
				sleepFn: () => {
					now += steps.shift() ?? 0;
					return Promise.resolve();
				},
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			// 120 + 1003 + 2377 ms: 3.5 s prints as 4, the float sum as 3.
			expect(lines.at(-1)).toBe(
				"q: gate opened after 4s — held 1s on the count cap, 3s on the memory rung\n",
			);
		});

		it("keeps the lowest MemAvailable a count-cap poll read beside it", async () => {
			const lines: string[] = [];
			const polls: object[] = [
				{ limb: "count", pids: [7], memory: { mb: 1800, rungMb: 2750 } },
			];
			await waitForGate({
				gate: () => polls.shift() ?? null,
				admit: noQueue,
				sleepFn: () => Promise.resolve(),
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.at(-1)).toMatch(
				/^q: gate opened after 0s — held 0s on the count cap; MemAvailable at lowest 1800 MB\n$/,
			);
		});

		it("prints none of it untraced", async () => {
			expect(await traced(gates(), false)).toEqual([
				"q: waiting\n",
				"q: gate opened after 50s\n",
			]);
		});

		it("breaks a wait refused at its bound down by limb", async () => {
			const lines: string[] = [];
			await waitForGate({
				gate: () => ({ limb: "memory", mb: 1000, rungMb: 2750 }),
				admit: noQueue,
				timeoutMs: 0,
				out: { write: (line: string) => lines.push(line) },
				label: "q",
				waiting: "waiting",
				traceLimbs: true,
			});
			expect(lines.slice(0, 3)).toEqual([
				"q: waiting\n",
				"q: after 0s, held on the memory rung, MemAvailable 1000 MB against ~2750 MB\n",
				"q: held 0s on the memory rung; MemAvailable at lowest 1000 MB\n",
			]);
		});
	});

	it("admits no run its own memory rung refuses, its turn open (#3058)", async () => {
		const admit = vi.fn(noQueue);
		const outcome = await waitForGate({
			gate: () => ({ limb: "memory" }),
			turn: () => true,
			admit,
			part: true,
			timeoutMs: 0,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
		});
		expect(outcome).toBe("refused");
		expect(admit).not.toHaveBeenCalled();
	});

	it("tells its caller each time the memory rung starts or stops holding it (#3058)", async () => {
		const gates = [
			{ limb: "memory" },
			{ limb: "memory" },
			{ limb: "count" },
			null,
		];
		const heard: boolean[] = [];
		await waitForGate({
			gate: () => gates.shift() ?? null,
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
			onMemoryHeld: (held: boolean) => heard.push(held),
		});
		expect(heard).toEqual([true, false]);
	});

	/** A wait on `gateRead`'s reading of the gate, asked about `gateWords`:
	 * how often it slept. */
	const sleepsUnder = async (
		gateRead: (command: string) => { limb: string } | null,
		gateWords?: string[],
	) => {
		const sleepFn = vi.fn(() => Promise.resolve());
		await waitForGate({
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
		expect(gateRead).toHaveBeenCalledWith("npm run test -- a.test.ts", null, 0);
	});

	it("hands the gate the weight the launch carries (#2931)", async () => {
		const gateRead = vi.fn(() => null);
		const gateWeight = weighed(40);
		await waitForGate({
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
		);
	});

	it("waits on each deny the gate reads", async () => {
		let denies = 2;
		const deny = () => (denies-- > 0 ? { limb: "count" } : null);
		expect(await sleepsUnder(deny)).toBe(2);
	});

	it("ends the wait early, and says why, where the check answers a base (#1158)", async () => {
		const lines: string[] = [];
		const left = await waitForGate({
			gate: () => true,
			leave: () => "abc123",
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(left).toBe("left");
		expect(lines.join("")).toMatch(/abc123 reaches no test file/);
		expect(lines.join("")).not.toMatch(/gate opened/);
	});
});

describe("waitForGate's timeout, judged on the last poll (#2421, #2714)", () => {
	const Memory = { limb: "memory", mb: 900, rungMb: 3250 };
	const Count = { limb: "count" };
	const Climb = (climbMb: number, mb = 4000) => ({
		limb: "memory",
		mb,
		rungMb: 2750,
		climbMb,
	});

	/** A wait whose clock moves 10 ms a poll, timing out on the third. */
	const timedWait = async (
		limbs: (object | null)[],
		{
			part = false,
			turn = (): boolean => true,
			hold,
		}: {
			part?: boolean;
			turn?: () => boolean;
			hold?: () => Promise<boolean>;
		} = {},
	) => {
		let now = 0;
		let poll = 0;
		const said: string[] = [];
		const exits: unknown[][] = [];
		const outcome = await waitForGate({
			clock: () => now,
			gate: () => {
				now += 10;
				return limbs[Math.min(poll++, limbs.length - 1)];
			},
			timeoutMs: 30,
			part,
			turn,
			...(hold ? { hold } : {}),
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (s: string) => said.push(s) },
			onExit: (...args: unknown[]) => exits.push(args),
		});
		return { outcome, said: said.join(""), exits, polls: poll };
	};

	it("records the highest charge that held a wait, on whichever exit ends it (#3806)", async () => {
		const opened = await timedWait([Climb(1400), Climb(1900), null]);
		expect(opened.exits).toEqual([["opened", 30, { climbMb: 1900 }]]);
		const refused = await timedWait([Climb(1900), Climb(1400), Climb(1400)]);
		expect(refused.exits).toEqual([
			["refused", 30, { limb: "memory", climbMb: 1900 }],
		]);
	});

	it("keeps the highest charge for a killed wait's exit line (#3806)", async () => {
		const stamps = seatStamps({ queueDir: qdir() });
		expect(stamps.killedHold()).toEqual({});
		let polls = 0;
		const limbs = [Climb(1900), Climb(1400), null];
		await waitForGate({
			...stamps,
			climbMb: () => 0,
			gate: () => limbs[polls++],
			sleepFn: () => Promise.resolve(),
			out: { write: () => true },
		});
		expect(stamps.killedHold()).toEqual({ climbMb: 1900 });
	});

	it("records no charge where the reading alone sat under the rung (#3806)", async () => {
		const wait = await timedWait([Climb(1900, 2000), null]);
		expect(wait.exits).toEqual([["opened", 20]]);
	});

	it("refuses a wait the memory rung holds at the last poll, naming the reading and the reap", async () => {
		const wait = await timedWait([Count, Count, Memory]);
		expect(wait.polls).toBe(3);
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "memory" }]]);
		expect(wait.said).toMatch(
			/gate still denies on memory after 0s \(MemAvailable 900 MB against the ~3250 MB rung\) — refused, not run/,
		);
		expect(wait.said).toMatch(/reap-finished-sessions\.js/);
		expect(wait.said).not.toMatch(/running anyway/);
	});

	it("refuses a whole suite the count cap holds at the bound, naming the bound and holding nothing", async () => {
		const hold = vi.fn(() => Promise.resolve(true));
		const wait = await timedWait([Memory, Memory, Count], { hold });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "count" }]]);
		expect(wait.said).toMatch(
			/gate still denies on its count cap after 0s, the queue's 0-minute wait bound — refused, not run/,
		);
		expect(wait.said).not.toMatch(/running anyway/);
		expect(hold).not.toHaveBeenCalled();
	});

	it("refuses a whole suite whose turn is still closed at the bound", async () => {
		const wait = await timedWait([null], { turn: () => false });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "turn" }]]);
		expect(wait.said).toMatch(
			/turn still closed after 0s, .* — refused, not run/,
		);
	});

	it("names the default bound in minutes", async () => {
		let now = 0;
		const said: string[] = [];
		await waitForGate({
			clock: () => now,
			gate: () => {
				now += 40 * 60 * 1000;
				return { limb: "count" };
			},
			admit: noQueue,
			sleepFn: () => Promise.resolve(),
			out: { write: (s: string) => said.push(s) },
		});
		expect(said.join("")).toMatch(/the queue's 40-minute wait bound/);
	});

	it("runs a part-suite anyway where the count cap or the turn holds the last poll", async () => {
		const count = await timedWait([Memory, Memory, Count], { part: true });
		expect(count.outcome).toBe("run");
		expect(count.exits).toEqual([["timeout", 30, { limb: "count" }]]);
		expect(count.said).toMatch(/running anyway/);
		const turn = await timedWait([null], { part: true, turn: () => false });
		expect(turn.outcome).toBe("run");
		expect(turn.exits).toEqual([["timeout", 30, { limb: "turn" }]]);
	});

	it("refuses a part-suite the memory rung holds at the last poll", async () => {
		const wait = await timedWait([Count, Count, Memory], { part: true });
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["refused", 30, { limb: "memory" }]]);
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

	/** The gate's reading with `mb` available and `suites` running, for a
	 * launch of `words` carrying `weight`, at a root whose workflow-core.json
	 * holds `config`. */
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
		/* An exported escape must not stand the poll's gate down. */
		vi.stubEnv("WFC_SUITE_CONCURRENT", "1");
		return gateDenies(
			words,
			(command: string, carried: typeof weight, climb: number) =>
				readGate(command, dir, carried, climb),
			weight,
			climbMb,
		);
	};

	it("names the memory limb, with the reading and the rung", () => {
		expect(ask(500, 0)).toEqual({
			limb: "memory",
			mb: 500,
			rungMb: expect.any(Number),
		});
	});

	/* A whole suite's rung is ~3.35 GB, so 4,000 MB passes it alone and fails
	 * it less a 1,500 MB climb (#3416). */
	it("charges the climb off MemAvailable, giving the reading itself and the charge apart", () => {
		expect(ask(4000, 0)).toBeNull();
		expect(ask(4000, 0, [], { climbMb: 1500 })).toEqual({
			limb: "memory",
			mb: 4000,
			rungMb: expect.any(Number),
			climbMb: 1500,
		});
	});

	/* The queue's turn counts markers alone; an unqueued or stood-down whole
	 * suite holds the slot through this limb (#2680). */
	it("names the count limb on a second whole suite, and lets a part-suite through", () => {
		expect(ask(20_000, 1)).toEqual({ limb: "count" });
		expect(ask(20_000, 1, ["scripts/a.test.ts"])).toBeNull();
	});

	it("admits a touched run while a whole suite holds the slot, a 200-file named run among them (#2935)", () => {
		expect(ask(20_000, 1, NAMED_200)).toBeNull();
		expect(ask(20_000, 1, NAMED_200, { weight: TOUCHED_200 })).toBeNull();
		/* The same 200 files resolved by a run that is not touched take it. */
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

	/* A module read as off on a config fault, as the guard's own context reads
	 * it, so the poll keeps the guard's verdict (#3137). */
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

	/** A suite's wait at a roomy guest, Windows' free memory read off a
	 * minute log each poll as memwatch leaves it; `frees` is what each sleep
	 * writes next. */
	const waitOn = async (first: number, frees: number[], timeoutMs = 60_000) => {
		const dir = qdir();
		const meminfo = path.join(dir, "meminfo");
		fs.writeFileSync(meminfo, `MemAvailable: ${20_000 * 1024} kB\n`);
		vi.stubEnv("WFC_MEMINFO", meminfo);
		vi.stubEnv("WFC_PS", writePsStub(dir, []));
		vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(dir, "config"));
		const log = path.join(dir, "memwatch-minute.jsonl");
		vi.stubEnv("MEMWATCH_MINUTE_LOG", log);
		const write = (mb: number) =>
			fs.appendFileSync(
				log,
				`${JSON.stringify({ ts: new Date().toISOString(), win_avail_mb: mb, win_age_s: 5 })}\n`,
			);
		write(first);
		const said: string[] = [];
		let clock = 0;
		const outcome = await waitForGate({
			gate: (climbMb: number) =>
				gateDenies(
					[],
					(command: string, carried: null, climb: number) =>
						readGate(command, dir, carried, climb),
					null,
					climbMb,
				),
			admit: noQueue,
			timeoutMs,
			clock: () => clock,
			sleepFn: (ms: number) => {
				clock += ms;
				const next = frees.shift();
				if (next !== undefined) write(next);
				return Promise.resolve();
			},
			traceLimbs: true,
			out: { write: (s: string) => said.push(s) },
		});
		return { outcome, said: said.join("") };
	};

	/* A whole suite draws 2250 MB, its 3350 MB rung less the empty ladder's
	 * 1100, and Windows must hold that and the 300 MB margin. */
	it("holds a suite launch while Windows is short, and admits it once Windows clears", async () => {
		const { outcome, said } = await waitOn(1440, [2549, 2550]);
		expect(outcome).toBe("run");
		expect(said).toContain(
			"held on the Windows-memory hold, Windows free 1440 MB against ~2550 MB",
		);
		expect(said).toMatch(
			/gate opened after 20s — held 20s on the Windows-memory hold/,
		);
	});

	it("refuses at the bound, not run, where Windows never clears", async () => {
		const { outcome, said } = await waitOn(900, [900, 900], 20_000);
		expect(outcome).toBe("refused");
		expect(said).toContain(
			"the Windows-memory hold still holds after 20s (Windows free 900 MB against ~2550 MB) — refused, not run.",
		);
	});
});

describe("queueSeat, one seat's lifecycle end to end (#4240)", () => {
	const markersIn = (dir: string) =>
		fs.readdirSync(dir).filter((f) => f.startsWith("wfc-suite-queue-"));
	const recordIn = (dir: string) =>
		JSON.parse(
			fs.readFileSync(path.join(dir, markersIn(dir)[0] as string), "utf8"),
		);
	const never = () =>
		new Promise<void>(() => {
			/* never settles */
		});
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
			// Past its leave too: the caller still answers for the process.
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
