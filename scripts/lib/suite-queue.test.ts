// @vitest-environment node
/*
 * `npm run test -- --queue`'s wait: the turn order between waiters, the gate
 * poll, and the `(pid, start)` staleness rule and marker walk shared between
 * `queueTurn` (which sweeps a stale marker on sight) and
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
 * The ordering cases write real markers into a temp directory of their own.
 * That a KILLED waiter drops its marker is run-vitest.js's signal handler,
 * tested there through a real process.
 * In the world, a wrong verdict lets `npm run test -- --queue` sweep a live
 * suite's marker and start past it on the memory-capped machine, or wait
 * behind a dead one.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { suiteRungMb, WHOLE_SUITE_WORKERS } from "./admission.js";
import { mkScratchDir } from "./git-fixture";
import { writePsStub } from "./ps-stub";
import { runInProcess } from "./run-in-process.js";
import { WHOLE_SLOT_BOUND } from "./whole-slot-bound";

const {
	isMarkerStale,
	readMarkers,
	readStartTimeOf,
	queueJoin,
	queueLeave,
	queueAdmit,
	queueSpawned,
	queueStamps,
	queueTurn,
	passingTurn,
	readLiveRolePids,
	gateDenies,
	heldSeat,
	SEAT_ENV,
	waitForGate,
} = require("./suite-queue.js");
const { yieldToWhole } = require("./cpu-yield.js");
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

	/* queueTurn orders on a numeric `at`, so the walk it shares with
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
	const prior = process.env.TMPDIR;
	afterEach(() => {
		if (prior === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = prior;
	});

	/* A reader restating the temp root reads none of this queue. */
	it("is one directory under the temp root, which the root's listing never reaches", () => {
		const root = qdir();
		process.env.TMPDIR = root;
		const file = queueJoin({ role: "lander" });
		queueSpawned(file);
		const swept = queueJoin({ pid: 2 ** 30 });

		expect(fs.readdirSync(root)).toEqual(["wfc-suite-queue"]);
		expect(path.dirname(file)).toBe(path.join(root, "wfc-suite-queue"));
		expect(readLiveRolePids("lander")).toEqual([process.pid]);
		expect(readLiveLanders().pids).toEqual([process.pid]);
		expect(queueAdmit(file)).toBe("admitted");
		expect(queueTurn()).toBe(true);
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

		const stale = queueJoin({ pid: 2 ** 30 });
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

describe("readLiveRolePids (#2416)", () => {
	it("names the live markers of one role, sweeping none", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, role: "lander" });
		queueJoin({ queueDir, pid: 22, role: "lander" });
		queueJoin({ queueDir, pid: 33 });
		expect(
			readLiveRolePids("lander", {
				queueDir,
				alive: (pid: number) => pid !== 22,
			}),
		).toEqual([11]);
		expect(fs.readdirSync(queueDir)).toHaveLength(3);
	});
});

describe("heldSeat, a mutation loop's one seat (#2918)", () => {
	/* 40 → 30 → 20 → 10: the run is 40, its driver 30, the seat 20. */
	const parentOf = (pid: number) => (pid > 10 ? pid - 10 : 1);
	const seat = (weight = PART, spawned = true) => {
		const queueDir = qdir();
		const file = queueJoin({ queueDir, pid: 20, weight });
		if (spawned) queueSpawned(file);
		return file;
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
		const file = queueJoin({ queueDir, pid: process.ppid, weight: PART });
		queueSpawned(file);
		expect(heldSeat({ env: { [SEAT_ENV]: file } })).toBe(file);
	});
});

describe("the queue's ordering, so waiters do not stampede (mantahostels#2024)", () => {
	/** Everything alive except the pids named. */
	const deadOnly =
		(...dead: number[]) =>
		(pid: number) =>
			!dead.includes(pid);

	it("says yes when nobody else is queued", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		expect(queueTurn({ queueDir, pid: 11, alive: () => true })).toBe(true);
	});

	it("says no while an older waiter is still alive", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		expect(queueTurn({ queueDir, pid: 22, alive: () => true, slots: 1 })).toBe(
			false,
		);
		expect(queueTurn({ queueDir, pid: 11, alive: () => true, slots: 1 })).toBe(
			true,
		);
	});

	// #2680's cap: one whole suite at a time.
	it("holds a whole suite while a queued one ahead of it runs, and opens once it leaves", () => {
		const queueDir = qdir();
		const ahead = queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		queueSpawned(ahead);
		expect(queueTurn({ queueDir, pid: 22, alive: () => true })).toBe(false);
		queueLeave(ahead);
		expect(queueTurn({ queueDir, pid: 22, alive: () => true })).toBe(true);
	});

	/* The gate counts `ps`, so two waiters admitted before either is visible
	 * would both read the same free slot. Two slots, so the spawn alone opens
	 * the turn. */
	it("holds a waiter while one ahead of it has not spawned yet", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		const turn = () =>
			queueTurn({ queueDir, pid: 22, alive: () => true, slots: 2 });
		expect(turn()).toBe(false);
		queueSpawned(path.join(queueDir, "wfc-suite-queue-11.json"));
		expect(turn()).toBe(true);
	});

	describe("a part-suite, which takes no slot (#2558)", () => {
		const marker = (queueDir: string, pid: number) =>
			path.join(queueDir, `wfc-suite-queue-${pid}.json`);

		it("runs beside whole suites holding every slot", () => {
			const queueDir = qdir();
			const whole = Array.from(
				{ length: WHOLE_SUITE_MAX + 1 },
				(_, i) => 11 + i,
			);
			for (const pid of whole) queueJoin({ queueDir, pid, clock: () => pid });
			for (const pid of whole.slice(0, WHOLE_SUITE_MAX))
				queueSpawned(marker(queueDir, pid));
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: PART });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("runs past an older whole suite the gate still holds unspawned (#2578)", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: PART });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
			expect(queueTurn({ queueDir, pid: 11, alive: () => true })).toBe(true);
		});

		it("still waits for a part-suite ahead of it to spawn", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11, weight: PART });
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: PART });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(false);
			queueSpawned(marker(queueDir, 11));
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		describe("passing an older part-suite the memory rung holds (#3058)", () => {
			/* Mirrors PART_PASS_AGE_MS. */
			const AgeMs = 8 * 60 * 1000;
			const twoPartWaiters = (queueDir: string) => {
				queueJoin({ queueDir, pid: 11, clock: () => 0, weight: PART });
				queueJoin({ queueDir, pid: 99, clock: () => 1000, weight: PART });
				return (now: number) =>
					queueTurn({ queueDir, pid: 99, alive: () => true, clock: () => now });
			};

			it("gives the younger its turn", () => {
				const queueDir = qdir();
				const turn = twoPartWaiters(queueDir);
				queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
				expect(turn(AgeMs - 1)).toBe(true);
			});

			it("stops passing once the older waiter's wait reaches the age bound", () => {
				const queueDir = qdir();
				const turn = twoPartWaiters(queueDir);
				queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
				expect(turn(AgeMs)).toBe(false);
			});

			it("never passes an older waiter held only on its turn", () => {
				const queueDir = qdir();
				const turn = twoPartWaiters(queueDir);
				expect(turn(1000)).toBe(false);
				queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
				queueStamps(marker(queueDir, 11)).onMemoryHeld(false);
				expect(turn(1000)).toBe(false);
			});

			it("drops the stamp its waiter's onMemoryHeld wrote", () => {
				const queueDir = qdir();
				const file = queueJoin({
					queueDir,
					pid: 11,
					clock: () => 0,
					weight: PART,
				});
				const { onMemoryHeld } = queueStamps(file, { queueDir, pid: 11 });
				const readMemoryHeld = () =>
					JSON.parse(fs.readFileSync(file, "utf8")).memoryHeld;
				onMemoryHeld(true);
				expect(readMemoryHeld()).toBe(true);
				onMemoryHeld(false);
				expect(readMemoryHeld()).toBeUndefined();
			});

			describe("the count its exit line carries (#3115)", () => {
				const opened = (options: object) => {
					const { turn, exitFields } = passingTurn({
						alive: () => true,
						...options,
					});
					return { open: turn(), fields: exitFields("opened") };
				};

				it("counts the memory-held waiters it passed, never a spawned one", () => {
					const queueDir = qdir();
					queueJoin({ queueDir, pid: 11, clock: () => 0, weight: PART });
					queueJoin({ queueDir, pid: 22, clock: () => 500, weight: PART });
					queueJoin({ queueDir, pid: 99, clock: () => 1000, weight: PART });
					queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
					queueSpawned(marker(queueDir, 22));
					expect(opened({ queueDir, pid: 99, clock: () => 2000 })).toEqual({
						open: true,
						fields: { passed: 1 },
					});
				});

				it("carries 0 where the turn opened passing none", () => {
					const queueDir = qdir();
					queueJoin({ queueDir, pid: 99, clock: () => 0, weight: PART });
					expect(opened({ queueDir, pid: 99 })).toEqual({
						open: true,
						fields: { passed: 0 },
					});
				});

				it("carries nothing for a whole suite", () => {
					const queueDir = qdir();
					queueJoin({ queueDir, pid: 33, clock: () => 0 });
					expect(opened({ queueDir, pid: 33 })).toEqual({
						open: true,
						fields: {},
					});
				});

				it("carries nothing once a later read closes", () => {
					const queueDir = qdir();
					twoPartWaiters(queueDir);
					queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
					const { turn, exitFields } = passingTurn({
						queueDir,
						pid: 99,
						alive: () => true,
						clock: () => 2000,
					});
					expect(turn()).toBe(true);
					queueStamps(marker(queueDir, 11)).onMemoryHeld(false);
					expect(turn()).toBe(false);
					expect(exitFields("opened")).toEqual({});
				});

				it("carries nothing on an exit other than opened, the count it read being stale there", () => {
					const queueDir = qdir();
					twoPartWaiters(queueDir);
					queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
					const { turn, exitFields } = passingTurn({
						queueDir,
						pid: 99,
						alive: () => true,
						clock: () => 2000,
					});
					expect(turn()).toBe(true);
					expect(exitFields("refused", { limb: "memory" })).toEqual({
						limb: "memory",
					});
				});
			});

			it("never lets a whole suite pass it", () => {
				const queueDir = qdir();
				queueJoin({ queueDir, pid: 11, clock: () => 0, weight: PART });
				queueJoin({ queueDir, pid: 99, clock: () => 1000 });
				queueStamps(marker(queueDir, 11)).onMemoryHeld(true);
				expect(
					queueTurn({
						queueDir,
						pid: 99,
						alive: () => true,
						clock: () => 2000,
					}),
				).toBe(false);
			});
		});

		it("keeps whole suites in FIFO order while a part-suite backfills past them", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueJoin({ queueDir, pid: 22, clock: () => 22 });
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: PART });
			const turn = (pid: number) =>
				queueTurn({ queueDir, pid, alive: () => true });
			expect(turn(99)).toBe(true);
			queueSpawned(marker(queueDir, 99));
			expect([11, 22].map(turn)).toEqual([true, false]);
			queueSpawned(marker(queueDir, 11));
			expect(turn(22)).toBe(false);
			queueLeave(marker(queueDir, 11));
			expect(turn(22)).toBe(true);
		});

		it("holds a whole suite behind an unspawned part-suite ahead of it", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11, weight: PART });
			queueJoin({ queueDir, pid: 99, clock: () => 99 });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(false);
			queueSpawned(marker(queueDir, 11));
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		/* An admitted launch is not yet in `ps`, so every other waiter, ahead or
		 * behind, waits it out (#601). */
		it.each([
			["a part-suite behind an admitted whole suite", 11, 99],
			["a whole suite ahead of an admitted part-suite", 99, 11],
		])("holds %s until it spawns", (_, launcher, waiter) => {
			const queueDir = qdir();
			for (const pid of [11, 99])
				queueJoin({
					queueDir,
					pid,
					clock: () => pid,
					...(pid === 99 ? { weight: PART } : {}),
				});
			queueAdmit(marker(queueDir, launcher), {
				queueDir,
				pid: launcher,
				alive: () => true,
			});
			expect(queueTurn({ queueDir, pid: waiter, alive: () => true })).toBe(
				false,
			);
			queueSpawned(marker(queueDir, launcher));
			expect(queueTurn({ queueDir, pid: waiter, alive: () => true })).toBe(
				true,
			);
		});

		it("takes no slot from a whole suite behind it", () => {
			const queueDir = qdir();
			const parts = Array.from({ length: SUITE_MAX }, (_, i) => 11 + i);
			for (const pid of parts) {
				queueJoin({ queueDir, pid, clock: () => pid, weight: PART });
				queueSpawned(marker(queueDir, pid));
			}
			queueJoin({ queueDir, pid: 99, clock: () => 99 });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		/* The line is WHOLE_SLOT_BOUND, never the whole suite's worker count. */
		it.each([
			[2, "comes", true],
			[WHOLE_SLOT_BOUND - 1, "comes", true],
			[WHOLE_SLOT_BOUND, "waits", false],
			[485, "waits", false],
		])(
			"beside a running whole suite, a run resolving to %i files' turn %s (#2931)",
			(n, _verb, turn) => {
				const queueDir = qdir();
				queueJoin({ queueDir, pid: 11, clock: () => 11 });
				queueSpawned(marker(queueDir, 11));
				queueJoin({ queueDir, pid: 99, clock: () => 99, weight: weighed(n) });
				expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(turn);
			},
		);

		it("seats a `--changed` run resolving below the bound beside a held slot (#2931)", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueSpawned(marker(queueDir, 11));
			/* `--changed`'s plan selected 40 files; its argv names none. */
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: weighed(40) });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("never seats a full run of a 50-file repo on the slot (#2931)", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueSpawned(marker(queueDir, 11));
			const suite = Array.from({ length: 50 }, (_, i) => `t${i}.test.ts`);
			const weight = weighed(resolvedFileCount([], () => suite));
			expect(weight).toEqual({ resolvedFiles: 50, wholeSlot: false });
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("seats a touched run beside a held slot, a 200-file named run among them (#2935)", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueSpawned(marker(queueDir, 11));
			queueJoin({ queueDir, pid: 99, clock: () => 99, weight: TOUCHED_200 });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("joins a waiter with no carried weight whole", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueSpawned(marker(queueDir, 11));
			queueJoin({ queueDir, pid: 99, clock: () => 99 });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(false);
		});
	});

	it("steps over a dead waiter's marker, and sweeps it", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		expect(
			queueTurn({ queueDir, pid: 22, alive: deadOnly(11), slots: 1 }),
		).toBe(true);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-22.json"]);
	});

	/* Markers are read in directory order, which is lexicographic, so
	 * `…-100.json` is read before `…-9.json`, and without the tie-break the
	 * first one read wins (mantahostels#2024). */
	it("breaks a tied timestamp on pid, so both waiters agree", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 100, clock: () => 100 });
		queueJoin({ queueDir, pid: 9, clock: () => 100 });
		expect(queueTurn({ queueDir, pid: 9, alive: () => true, slots: 1 })).toBe(
			true,
		);
		expect(queueTurn({ queueDir, pid: 100, alive: () => true, slots: 1 })).toBe(
			false,
		);
	});

	it("ignores a marker that is not JSON rather than throwing", () => {
		const queueDir = qdir();
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-99.json"),
			"not json",
		);
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		expect(queueTurn({ queueDir, pid: 11, alive: () => true })).toBe(true);
	});

	it("fails open when the queue directory cannot be read", () => {
		expect(queueTurn({ queueDir: "/no/such/queue/dir", pid: 11 })).toBe(true);
	});

	it("leaving removes only this waiter's marker", () => {
		const queueDir = qdir();
		const mine = queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		queueLeave(mine);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-22.json"]);
	});

	it("does not sweep its own marker even if the liveness probe says dead", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		expect(queueTurn({ queueDir, pid: 11, alive: () => false })).toBe(true);
		expect(fs.readdirSync(queueDir)).toEqual(["wfc-suite-queue-11.json"]);
	});

	/* A leaked marker whose pid is later reused by an unrelated process
	 * (mantahostels#2034). */
	it("treats a reused pid as stale, even though it is alive", () => {
		const queueDir = qdir();
		const mine = queueJoin({ queueDir, pid: 11, clock: () => 100 });
		// A marker claiming a start time that the live process does not have.
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-12.json"),
			JSON.stringify({ pid: 12, at: 50, start: 999_999_999 }),
		);
		expect(queueTurn({ queueDir, pid: 11, alive: () => true, slots: 1 })).toBe(
			true,
		);
		expect(fs.readdirSync(queueDir)).toEqual([path.basename(mine)]);
	});

	/* Markers written before mantahostels#2034 carry no start time, and procfs may not be
	 * readable at all. Neither may be read as "stale" — that would sweep live
	 * waiters. */
	it("falls back to liveness alone when a marker carries no start time", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		fs.writeFileSync(
			path.join(queueDir, "wfc-suite-queue-12.json"),
			JSON.stringify({ pid: 12, at: 50 }),
		);
		expect(queueTurn({ queueDir, pid: 11, alive: () => true, slots: 1 })).toBe(
			false,
		);
		expect(fs.readdirSync(queueDir)).toHaveLength(2);
	});

	/* A start of 0 is what queueJoin writes when procfs cannot be read. Without
	 * the `> 0` guard the comparison runs against a real start time, never
	 * matches, and every such waiter is swept as stale. */
	it("falls back to liveness when a marker records a start time of 0", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		/* THIS process's pid, so `readStartTimeOf` returns a real, non-zero tick
		 * count. A pid with no readable /proc entry returns 0 on both sides of
		 * the comparison (mantahostels#2034). */
		fs.writeFileSync(
			path.join(queueDir, `wfc-suite-queue-${process.pid}.json`),
			JSON.stringify({ pid: process.pid, at: 50, start: 0 }),
		);
		expect(queueTurn({ queueDir, pid: 11, alive: () => true, slots: 1 })).toBe(
			false,
		);
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
	const file = (queueDir: string, pid: number) =>
		path.join(queueDir, `wfc-suite-queue-${pid}.json`);
	const admitted = (queueDir: string, pid: number) =>
		JSON.parse(fs.readFileSync(file(queueDir, pid), "utf8")).admitted === true;
	const alive = () => true;
	/** Stamp `pid` admitted as its own `queueAdmit` would, before its re-read. */
	const stamp = (queueDir: string, pid: number) => {
		const record = JSON.parse(fs.readFileSync(file(queueDir, pid), "utf8"));
		fs.writeFileSync(
			file(queueDir, pid),
			JSON.stringify({ ...record, admitted: true }),
		);
	};

	/** Two joined waiters, 11 ahead of 22. */
	const pair = () => {
		const queueDir = qdir();
		for (const pid of [11, 22]) queueJoin({ queueDir, pid, clock: () => pid });
		return queueDir;
	};

	/** A queue fs that runs `between` before every directory read: inside
	 * `queueAdmit`, between its stamp and its re-read. */
	const onReread = (between: () => void) => ({
		...fs,
		readdirSync: (dir: string) => {
			between();
			return fs.readdirSync(dir);
		},
	});

	it("yields where the other stamped and re-read in between, so one launches", () => {
		const queueDir = pair();
		let other = "";
		const queueFs = onReread(() => {
			other ||= queueAdmit(file(queueDir, 22), { queueDir, pid: 22, alive });
		});
		const mine = queueAdmit(file(queueDir, 11), {
			queueDir,
			queueFs,
			pid: 11,
			alive,
		});
		expect([mine, other]).toEqual(["admitted", "behind"]);
		expect([admitted(queueDir, 11), admitted(queueDir, 22)]).toEqual([
			true,
			false,
		]);
	});

	it.each([
		["the older", 11, 22, "ahead"],
		["the younger", 22, 11, "behind"],
	])(
		"yields as %s where both stamped before either re-read",
		(_, pid, rival, how) => {
			const queueDir = pair();
			const queueFs = onReread(() => stamp(queueDir, rival));
			expect(
				queueAdmit(file(queueDir, pid), { queueDir, queueFs, pid, alive }),
			).toBe(how);
			expect(admitted(queueDir, pid)).toBe(false);
			expect(
				queueAdmit(file(queueDir, rival), { queueDir, pid: rival, alive }),
			).toBe("admitted");
		},
	);

	it("ignores a rival already spawned", () => {
		const queueDir = pair();
		stamp(queueDir, 22);
		queueSpawned(file(queueDir, 22));
		expect(queueAdmit(file(queueDir, 11), { queueDir, pid: 11, alive })).toBe(
			"admitted",
		);
	});

	/* A whole suite and the part-suite backfilling behind it, freed on one
	 * poll, with a load hold between each turn and its launch: the re-read
	 * after the hold settles it, so `queueAdmit`'s contest (pinned above) is
	 * never reached. A launch spawns once its rival next sleeps. */
	it("never launches both unspawned", async () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 11 });
		queueJoin({ queueDir, pid: 22, clock: () => 22, weight: PART });
		const launched: number[] = [];
		const beside: boolean[] = [];
		const wait = (pid: number) =>
			waitForGate({
				gate: () => null,
				turn: () => queueTurn({ queueDir, pid, alive }),
				hold: () => Promise.resolve(true),
				admit: () => queueAdmit(file(queueDir, pid), { queueDir, pid, alive }),
				sleepFn: () => {
					for (const done of launched) queueSpawned(file(queueDir, done));
					return Promise.resolve();
				},
				out: { write: () => true },
			}).then((outcome: string) => {
				const rival = pid === 11 ? 22 : 11;
				const record = JSON.parse(
					fs.readFileSync(file(queueDir, rival), "utf8"),
				);
				beside.push(record.admitted === true && record.spawned !== true);
				launched.push(pid);
				expect(outcome).toBe("run");
			});
		await Promise.all([wait(11), wait(22)]);
		expect(launched).toHaveLength(2);
		expect(beside).toEqual([false, false]);
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
		expect(gateRead).toHaveBeenCalledWith("npm run test -- a.test.ts", null);
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
		expect(read).toHaveBeenCalledWith(command, null);
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

	afterEach(() => {
		vi.unstubAllEnvs();
	});

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
		}: {
			weight?: { resolvedFiles: number | null; wholeSlot: boolean } | null;
			config?: string | null;
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
			(command: string, carried: typeof weight) =>
				readGate(command, dir, carried),
			weight,
		);
	};

	it("names the memory limb, with the reading and the rung", () => {
		expect(ask(500, 0)).toEqual({
			limb: "memory",
			mb: 500,
			rungMb: expect.any(Number),
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
		expect(ask(1449, 0, NAMED_200, { weight: TOUCHED_200 })).toMatchObject({
			limb: "memory",
			rungMb: suiteRungMb(WHOLE_SUITE_WORKERS),
		});
		expect(ask(1449, 0, ["scripts/a.test.ts"], { weight: weighed(1) })).toEqual(
			{
				limb: "memory",
				mb: 1449,
				rungMb: 1450,
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

	it("lets a one-file run's poll through at 1,450 MB, where a whole suite's is held", () => {
		expect(ask(1450, 0, ["scripts/a.test.ts"])).toBeNull();
		expect(ask(1449, 0, ["scripts/a.test.ts"])).toEqual({
			limb: "memory",
			mb: 1449,
			rungMb: 1450,
		});
		expect(ask(1450, 0)).toMatchObject({
			limb: "memory",
			rungMb: suiteRungMb(WHOLE_SUITE_WORKERS),
		});
	});
});
