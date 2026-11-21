// @vitest-environment node
/*
 * gate-seat.js (#5274): a commit gate's seat in the suite queue. The markers
 * and the gate-run record are real files in a scratch directory; process
 * ancestry is injected, being a shape a real process tree cannot stage. In the world, a wrong verdict counts one gate's three lanes as three
 * whole suites and holds every other run out, lets a process that inherited
 * the variable skip the count, or under-charges an unmeasured gate.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./git-fixture";

const {
	GATE_SEAT_DEFAULT_MB,
	appendGateRun,
	gateHeldUntil,
	gatePositionLine,
	gateSeatChargeMb,
	readGatePids,
	startGatePids,
} = require("./gate-seat.js");
const {
	readGateSeats,
	readLiveGateSeats,
	readSlotPlace,
} = require("./suite-queue.js");
const { runningSuites } = require("./suite-ladder.js");
const { WHOLE_SUITE_WORKERS } = require("./suite-bounded.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const queue = () => {
	const dir = mkScratchDir("gate-seat-");
	dirs.push(dir);
	const marker = (record: object) => {
		const pid = (record as { pid: number }).pid;
		const file = path.join(dir, `wfc-suite-queue-${pid}.json`);
		fs.writeFileSync(file, JSON.stringify({ at: 0, ...record }));
		return file;
	};
	return { dir, marker };
};

/* 40 → 30 → 20 → 10: the seat's holder is the live test process, the
 * runner under it 40. */
const tree = (holder: number) => (pid: number) => {
	if (pid === 30) return holder;
	return pid > 10 ? pid - 10 : 1;
};

describe("the gate seat's charge", () => {
	it("is the repo's declared gateSeatMb, else the whole-suite rung", () => {
		expect(gateSeatChargeMb({ gateSeatMb: 2400 })).toBe(2400);
		expect(gateSeatChargeMb({})).toBe(GATE_SEAT_DEFAULT_MB);
		expect(gateSeatChargeMb(null)).toBe(3350);
	});
});

describe("readLiveGateSeats", () => {
	it("reads every live gate marker, queued or running, with its charge", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", chargeMb: 2100, spawned: true });
		q.marker({ pid: 999_999_999, role: "gate" });
		q.marker({ pid: process.ppid, role: "lander", chargeMb: 1 });
		expect(readLiveGateSeats({ queueDir: q.dir })).toEqual({
			live: [{ pid: process.pid, chargeMb: 2100, spawned: true, part: false }],
			unread: null,
		});
	});

	/* Positive pair: "reads every live gate marker, queued or running, with its charge". */
	it("holds the default charge, and says why, where the queue will not read (#5301)", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", chargeMb: 2100 });
		fs.chmodSync(q.dir, 0o000);
		try {
			expect(readLiveGateSeats({ queueDir: q.dir })).toEqual({
				live: [],
				unread: {
					why: expect.stringMatching(/would not read \(EACCES/),
					chargeMb: GATE_SEAT_DEFAULT_MB,
				},
			});
		} finally {
			fs.chmodSync(q.dir, 0o755);
		}
	});
});

describe("readGateSeats, the count's reading of the seats", () => {
	it("places a runner among a spawned seat's holder's descendants under it", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", spawned: true });
		const seats = readGateSeats({
			queueDir: q.dir,
			parentOf: tree(process.pid),
		});
		expect(seats.count).toBe(1);
		expect(seats.under(40)).toBe(true);
		expect(seats.under(process.pid)).toBe(true);
	});

	it("counts a short seat as a part-suite, its runners still under it (#5450)", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", spawned: true, part: true });
		const seats = readGateSeats({
			queueDir: q.dir,
			parentOf: tree(process.pid),
		});
		expect(seats).toMatchObject({ count: 0, part: 1 });
		expect(seats.under(40)).toBe(true);
	});

	it("counts a process outside the seat's tree as itself, whatever it inherited", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", spawned: true });
		const seats = readGateSeats({ queueDir: q.dir, parentOf: () => 1 });
		expect(seats.under(40)).toBe(false);
		expect(seats.under(null)).toBe(false);
	});

	/* Positive pair: "places a runner among a spawned seat's holder's descendants under it". */
	it("counts no seat, and says why, where the queue will not read (#5301)", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate", spawned: true });
		fs.chmodSync(q.dir, 0o000);
		try {
			const seats = readGateSeats({
				queueDir: q.dir,
				parentOf: tree(process.pid),
			});
			expect(seats.count).toBe(0);
			expect(seats.under(40)).toBe(false);
			expect(seats.unread).toMatch(/would not read \(EACCES/);
		} finally {
			fs.chmodSync(q.dir, 0o755);
		}
	});

	it("places nothing under a seat still waiting, which holds no slot", () => {
		const q = queue();
		q.marker({ pid: process.pid, role: "gate" });
		const seats = readGateSeats({
			queueDir: q.dir,
			parentOf: tree(process.pid),
		});
		expect(seats.count).toBe(0);
		expect(seats.under(40)).toBe(false);
	});
});

describe("a waiting gate's place", () => {
	it("is unknown, and says why, where the queue will not read", () => {
		const q = queue();
		const notADir = path.join(q.dir, "plain-file");
		fs.writeFileSync(notADir, "");
		const place = readSlotPlace({ queueDir: notADir });
		expect(place).toMatchObject({ position: null, holder: null });
		const line = gatePositionLine({ ...place, waitedS: 7 });
		expect(line).toMatch(/place for the whole-suite slot unknown/);
		expect(line).toMatch(/ENOTDIR/);
		expect(line).not.toMatch(/position 1|slot free/);
	});
});

describe("runningSuites with a gate seat", () => {
	// Lanes naming no file, each a whole suite on its own.
	const lanes = [
		{ pid: 40, args: "node --test lanes/a" },
		{ pid: 41, args: "node --test lanes/b" },
		{ pid: 42, args: "node --test lanes/c" },
	];
	const isOther = (words: string[]) => words[1] === "--test";

	it("reads one gate with three lanes as one whole suite", () => {
		expect(
			runningSuites(lanes, isOther, () => null, {
				count: 1,
				part: 0,
				under: () => true,
				unread: null,
			}),
		).toEqual({
			total: 1,
			watchers: 0,
			whole: 1,
			workers: WHOLE_SUITE_WORKERS,
		});
	});

	it("reads a short gate with three lanes as one part-suite (#5450)", () => {
		expect(
			runningSuites(lanes, isOther, () => null, {
				count: 0,
				part: 1,
				under: () => true,
				unread: null,
			}),
		).toEqual({ total: 1, watchers: 0, whole: 0, workers: 0 });
	});

	it("still counts a runner outside the seat", () => {
		expect(
			runningSuites(lanes, isOther, () => null, {
				count: 1,
				part: 0,
				under: (pid: number | null) => pid !== 42,
				unread: null,
			}).whole,
		).toBe(2);
	});
});

describe("the gate-run record", () => {
	it("appends one line per gate run with every field", () => {
		const q = queue();
		const file = path.join(q.dir, ".gate-runs.jsonl");
		const run = {
			at: new Date().toISOString(),
			repo: "design-vault",
			command: "bash test/all.sh",
			session: "s1",
			ticket: 433,
			waitS: 120,
			runS: 600,
			outcome: "pass",
			peakTreeMb: 2900,
		};
		expect(appendGateRun(file, run)).toBe(true);
		expect(
			fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l)),
		).toEqual([run]);
	});
});

describe("the gate seat's pid record (#5269)", () => {
	const holder = {
		repo: "design-vault",
		command: "bash test/all.sh",
		session: "s1",
	};

	it("records each pid's last sighting in the run-memory store, read back as a seat and never as a test run", () => {
		const { dir } = queue();
		let now = 1_000_000;
		const pids = startGatePids(holder, {
			sampleMs: 2000,
			pid: 7,
			dir,
			now: () => now,
			bootId: "b",
		});
		expect(path.basename(pids.file)).toBe("gate-7-1000000.json");
		pids.see([40, 41]);
		now += 2000;
		pids.see([40]);
		now += 500;
		pids.stop();
		const { seats, why } = readGatePids(dir);
		expect(why).toBeNull();
		expect(seats).toEqual([
			{
				...holder,
				at: new Date(1_000_000).toISOString(),
				bootId: "b",
				sampleMs: 2000,
				sampledAt: new Date(1_002_000).toISOString(),
				seenAt: {
					40: new Date(1_002_000).toISOString(),
					41: new Date(1_000_000).toISOString(),
				},
				endedAt: new Date(1_002_500).toISOString(),
			},
		]);
		expect(require("./run-memory.js").readRunFiles(dir)).toEqual({
			runs: [],
			why: null,
		});
	});

	it("holds a pid to its last sighting plus two sample intervals, never past the record's last sample, and no pid it never saw", () => {
		const seat = {
			sampleMs: 2000,
			sampledAt: new Date(10_000).toISOString(),
			seenAt: {
				40: new Date(4000).toISOString(),
				41: new Date(10_000).toISOString(),
			},
		};
		expect(gateHeldUntil(seat, 40)).toBe(8000);
		expect(gateHeldUntil(seat, 41)).toBe(14_000);
		expect(gateHeldUntil(seat, 42)).toBeNull();
		expect(
			gateHeldUntil({ ...seat, endedAt: new Date(6000).toISOString() }, 41),
		).toBe(10_000);
	});

	it("never throws where the store cannot be written, answering why on stop", () => {
		const { dir } = queue();
		const blocked = path.join(dir, "file");
		fs.writeFileSync(blocked, "");
		const pids = startGatePids(holder, {
			sampleMs: 2000,
			dir: path.join(blocked, "store"),
		});
		pids.see([1]);
		expect(pids.stop()).toMatch(/ENOTDIR|EEXIST/);
	});
});
