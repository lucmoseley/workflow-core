// @vitest-environment node
/*
 * `npm run test -- --queue`'s wait: the turn order between waiters, the gate
 * poll, and the `(pid, start)` staleness rule and marker walk shared between
 * `queueTurn` (which sweeps a stale marker on sight) and
 * check-stale-suite-queue.js (which only reports one). Breaking a staleness case
 * here is silent everywhere else: the two callers do not test the rule
 * themselves, so it has one copy and cannot drift between them
 * (mantahostels#2034).
 *
 * `gateDenies`' limb cases spawn the real guard, its memory and `ps` staged at
 * its own seams, since the limb is the guard's to name.
 * Liveness and start time are injected as plain functions, so pid reuse can be
 * staged without a real reused pid; of the staleness cases only `startTimeOf`
 * reads a real process.
 * The ordering cases write real markers into a temp directory of their own.
 * That a KILLED waiter drops its marker is run-vitest.js's signal handler,
 * tested there through a real process.
 * In the world, a wrong verdict lets `npm run test -- --queue` sweep a live
 * suite's marker and start past it on the memory-capped machine, or wait
 * behind a dead one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkScratchDir } from "./git-fixture";
import { writePsStub } from "./ps-stub";

const {
	isMarkerStale,
	readMarkers,
	startTimeOf,
	queueJoin,
	queueLeave,
	queueAdmit,
	queueSpawned,
	queueTurn,
	liveRolePids,
	gateDenies,
	isPartSuite,
	waitForGate,
} = require("./suite-queue.js");

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

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

	/* A marker with no `start` key at all short-circuits before the reuse test
	 * ever runs, so a live pid whose start time differs still reads as live
	 * (mantahostels#2034). */
	it("does not judge reuse on a marker with no start at all, even against a live but reused pid", () => {
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

describe("startTimeOf", () => {
	it("reads a real process's start time, and 0 for one that is gone", () => {
		expect(startTimeOf(process.pid)).toBeGreaterThan(0);
		expect(startTimeOf(2 ** 30)).toBe(0);
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
		const { markers, error } = readMarkers("/no/such/dir", {
			readdirSync: () => {
				throw new Error("ENOENT");
			},
			readFileSync: () => "",
		} as unknown as FsStub);
		expect(markers).toEqual([]);
		expect(error).toBeInstanceOf(Error);
	});
});

describe("liveRolePids (#2416)", () => {
	it("names the live markers of one role, sweeping none", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, role: "lander" });
		queueJoin({ queueDir, pid: 22, role: "lander" });
		queueJoin({ queueDir, pid: 33 });
		expect(
			liveRolePids("lander", { queueDir, alive: (pid: number) => pid !== 22 }),
		).toEqual([11]);
		expect(fs.readdirSync(queueDir)).toHaveLength(3);
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

	// #159's cap: three suites at once.
	it("admits the SUITE_MAX oldest waiters and holds the next", () => {
		const { SUITE_MAX } = require("./admission.js");
		const queueDir = qdir();
		const pids = Array.from({ length: SUITE_MAX + 1 }, (_, i) => 11 + i);
		for (const pid of pids) queueJoin({ queueDir, pid, clock: () => pid });
		const turn = (pid: number) =>
			queueTurn({ queueDir, pid, alive: () => true });
		for (const pid of pids.slice(0, SUITE_MAX - 1))
			queueSpawned(path.join(queueDir, `wfc-suite-queue-${pid}.json`));
		expect(pids.map(turn)).toEqual(pids.map((_, i) => i < SUITE_MAX));
	});

	/* The gate counts `ps`, so two waiters admitted before either is visible
	 * would both read the same free slot. */
	it("holds a waiter while one ahead of it has not spawned yet", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		queueJoin({ queueDir, pid: 22, clock: () => 200 });
		expect(queueTurn({ queueDir, pid: 22, alive: () => true })).toBe(false);
		queueSpawned(path.join(queueDir, "wfc-suite-queue-11.json"));
		expect(queueTurn({ queueDir, pid: 22, alive: () => true })).toBe(true);
	});

	describe("a part-suite, which takes no slot (#2558)", () => {
		const { SUITE_MAX } = require("./admission.js");
		const marker = (queueDir: string, pid: number) =>
			path.join(queueDir, `wfc-suite-queue-${pid}.json`);

		it("runs behind SUITE_MAX whole suites holding every slot", () => {
			const queueDir = qdir();
			const whole = Array.from({ length: SUITE_MAX + 1 }, (_, i) => 11 + i);
			for (const pid of whole) queueJoin({ queueDir, pid, clock: () => pid });
			for (const pid of whole.slice(0, SUITE_MAX))
				queueSpawned(marker(queueDir, pid));
			queueJoin({ queueDir, pid: 99, clock: () => 99, part: true });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("runs past an older whole suite the gate still holds unspawned (#2578)", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueJoin({ queueDir, pid: 99, clock: () => 99, part: true });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
			expect(queueTurn({ queueDir, pid: 11, alive: () => true })).toBe(true);
		});

		it("still waits for a part-suite ahead of it to spawn", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11, part: true });
			queueJoin({ queueDir, pid: 99, clock: () => 99, part: true });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(false);
			queueSpawned(marker(queueDir, 11));
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});

		it("keeps whole suites in FIFO order while a part-suite backfills past them", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11 });
			queueJoin({ queueDir, pid: 22, clock: () => 22 });
			queueJoin({ queueDir, pid: 99, clock: () => 99, part: true });
			const turn = (pid: number) =>
				queueTurn({ queueDir, pid, alive: () => true });
			expect(turn(99)).toBe(true);
			queueSpawned(marker(queueDir, 99));
			expect([11, 22].map(turn)).toEqual([true, false]);
			queueSpawned(marker(queueDir, 11));
			expect(turn(22)).toBe(true);
		});

		it("holds a whole suite behind an unspawned part-suite ahead of it", () => {
			const queueDir = qdir();
			queueJoin({ queueDir, pid: 11, clock: () => 11, part: true });
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
				queueJoin({ queueDir, pid, clock: () => pid, part: pid === 99 });
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
				queueJoin({ queueDir, pid, clock: () => pid, part: true });
				queueSpawned(marker(queueDir, pid));
			}
			queueJoin({ queueDir, pid: 99, clock: () => 99 });
			expect(queueTurn({ queueDir, pid: 99, alive: () => true })).toBe(true);
		});
	});

	it.each([
		[["scripts/a.test.ts"], true],
		[["a.test.ts", "b.test.ts"], true],
		[["a.test.ts", "b.test.ts", "c.test.ts"], false],
		[[], false],
		[["run", "a.test.ts"], false],
		[["--adopt", "a.test.ts"], false],
	])("reads `%j` as a part-suite: %s", (words, part) => {
		expect(isPartSuite(words)).toBe(part);
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

	/* PIDS 9 AND 100 DELIBERATELY. Markers are read in directory order, which is
	 * lexicographic, so `…-100.json` is read BEFORE `…-9.json` — and without the
	 * tie-break the first one read simply wins (mantahostels#2024). */
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

	/* DISTINCT FROM THE CASE ABOVE. There a marker carries no `start` key at all;
	 * here it carries 0, which is what queueJoin writes when procfs cannot be
	 * read. Without the `> 0` guard the comparison runs against a real start
	 * time, never matches, and every such waiter is swept as stale. */
	it("falls back to liveness when a marker records a start time of 0", () => {
		const queueDir = qdir();
		queueJoin({ queueDir, pid: 11, clock: () => 100 });
		/* THIS process's pid, so `startTimeOf` returns a real, non-zero tick
		 * count. A pid with no readable /proc entry returns 0 on both sides of
		 * the comparison and the case proves nothing (mantahostels#2034). */
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
		queueJoin({ queueDir, pid: 22, clock: () => 22, part: true });
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
		expect(exits).toEqual(["opened"]);
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

	/** A wait already past its ceiling on the count cap. */
	const atCeiling = (options: object) => {
		const said: string[] = [];
		const outcome = waitForGate({
			timeoutMs: 0,
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
	it("says so when it waited", async () => {
		const lines: string[] = [];
		let closed = 1;
		await waitForGate({
			gate: () => closed-- > 0,
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(lines.join("")).toMatch(/waiting for it/);
		expect(lines.join("")).toMatch(/gate opened/);
	});

	/** A wait on the real gate's reading of `gateExec`: how often it slept. */
	const sleepsUnder = async (gateExec: () => string) => {
		const sleepFn = vi.fn(() => Promise.resolve());
		await waitForGate({ gateExec, sleepFn, out: { write: () => true } });
		return sleepFn.mock.calls.length;
	};

	it("fails open when the guard cannot be run", async () => {
		expect(
			await sleepsUnder(() => {
				throw new Error("ENOENT");
			}),
		).toBe(0);
	});

	it("asks the guard that sits beside the core's scripts", async () => {
		const gateExec = vi.fn(() => "");
		await sleepsUnder(gateExec);
		expect(gateExec).toHaveBeenCalledWith(
			"bash",
			[path.resolve(__dirname, "..", "guard-suite-concurrency.sh")],
			expect.anything(),
		);
	});

	it("reads a deny out of the guard's own JSON, and waits on it", async () => {
		let denies = 2;
		const deny = () =>
			denies-- > 0
				? JSON.stringify({
						hookSpecificOutput: { permissionDecision: "deny" },
					})
				: "";
		expect(await sleepsUnder(deny)).toBe(2);
	});

	it("ends the wait early, and says why, where the check answers a base (#1158)", async () => {
		const lines: string[] = [];
		const left = await waitForGate({
			gate: () => true,
			leave: () => "abc123",
			sleepFn: () => Promise.resolve(),
			out: { write: (line: string) => lines.push(line) },
		});
		expect(left).toBe("left");
		expect(lines.join("")).toMatch(/abc123 reaches no test file/);
		expect(lines.join("")).not.toMatch(/gate opened/);
	});
});

describe("waitForGate's timeout, judged on the last poll's limb (#2421)", () => {
	const Memory = { limb: "memory", mb: 900, rungMb: 3250 };
	const Count = { limb: "count" };

	/** A wait whose clock moves 10 ms a poll, timing out on the third. */
	const timedWait = async (limbs: object[], refuseAtCeiling = false) => {
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
			refuseAtCeiling,
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
		expect(wait.exits).toEqual([["refused", 30]]);
		expect(wait.said).toMatch(
			/gate still denies on memory after 0s \(MemAvailable 900 MB against the ~3250 MB rung\) — refused, not run/,
		);
		expect(wait.said).toMatch(/reap-finished-sessions\.js/);
		expect(wait.said).not.toMatch(/running anyway/);
	});

	it("runs anyway where the count cap holds the last poll, whatever the earlier polls said", async () => {
		const wait = await timedWait([Memory, Memory, Count]);
		expect(wait.polls).toBe(3);
		expect(wait.outcome).toBe("run");
		expect(wait.exits).toEqual([["timeout", 30]]);
		expect(wait.said).toMatch(/running anyway/);
	});

	it("refuses on the count cap too where the waiter asks it to, saying so (#2542)", async () => {
		const wait = await timedWait([Memory, Memory, Count], true);
		expect(wait.outcome).toBe("refused");
		expect(wait.exits).toEqual([["timeout", 30]]);
		expect(wait.said).toMatch(
			/gate still denies on its count cap after 0s — refused, not run/,
		);
		expect(wait.said).not.toMatch(/running anyway/);
	});
});

describe("gateDenies, against the real guard (#2421)", () => {
	const Scripts = path.resolve(__dirname, "..");

	/** The gate's reading with `mb` available and `suites` running, for a
	 * launch of `words`. */
	const ask = (mb: number, suites: number, words: string[] = []) => {
		const dir = qdir();
		const meminfo = path.join(dir, "meminfo");
		fs.writeFileSync(meminfo, `MemAvailable: ${mb * 1024} kB\n`);
		const ps = writePsStub(
			dir,
			Array.from(
				{ length: suites },
				() => "node /r/node_modules/.bin/vitest run",
			),
		);
		return gateDenies(
			Scripts,
			(file: string, args: string[], opts: { env: object }) =>
				execFileSync(file, args, {
					...opts,
					env: {
						...opts.env,
						WFC_MEMINFO: meminfo,
						WFC_PS: ps,
						CLAUDE_CONFIG_DIR: path.join(dir, "config"),
						CLAUDE_PROJECT_DIR: dir,
						WFC_READ_GRAPH_RENDERS: "0",
					},
				}),
			words,
		);
	};

	it("names the memory limb, with the reading and the rung", () => {
		expect(ask(500, 0)).toEqual({
			limb: "memory",
			mb: 500,
			rungMb: expect.any(Number),
		});
	});

	it("names the count limb on a fourth suite", () => {
		expect(ask(20_000, 3)).toEqual({ limb: "count" });
	});

	it("reads an open gate as null", () => {
		expect(ask(20_000, 0)).toBeNull();
	});

	it("lets a one-file run's poll through at 1,450 MB, where a whole suite's is held", () => {
		expect(ask(1450, 0, ["scripts/a.test.ts"])).toBeNull();
		expect(ask(1449, 0, ["scripts/a.test.ts"])).toEqual({
			limb: "memory",
			mb: 1449,
			rungMb: 1450,
		});
		expect(ask(1450, 0)).toMatchObject({ limb: "memory", rungMb: 2150 });
	});

	it("fails open on a guard that will not run", () => {
		expect(gateDenies(qdir())).toBeNull();
	});
});
