// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	holderAlive,
	readCurrentBootId,
	readProcStartOf,
} from "./arbiter-proc.js";
import { GH_TIMEOUT_MS } from "./gh-binary.js";
import { ADOPT_WAIT_MS } from "./guard-code.js";
import {
	GATED_COMMIT_TIMEOUT_MS,
	LANDER_GIT_TIMEOUT_MS,
	PUSH_TIMEOUT_MS,
} from "./lander-git.js";
import {
	HUNG_MS,
	readHeldExit,
	stallFindings,
	supervision,
} from "./landing-stall.js";
import { recordWake } from "./machine-clock.js";
import { INSTALL_TIMEOUT_MS } from "./npm-ci-staging.js";
import { FILING_TIMEOUT_MS } from "./queue-issue.js";
import { HOOK_GRACE_MS } from "./run-budgeted.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const Q = "b".repeat(40);
const MIN = 60 * 1000;
const STALL_MS = 120 * MIN;
const STALE_MS = 5 * MIN;

type Reading = Parameters<typeof stallFindings>[0];

const stale = (minutes: number) => NOW - STALL_MS - minutes * MIN;

const gauge = (since: number | null) => ({
	now: NOW,
	waiting: since === null ? [] : [{ name: "fix-it", sha: Q, since }],
	baseline: { spans: 0, p50Ms: null, p90Ms: null, depthP90: null },
});

const reading = (
	over: Partial<Reading> & { since?: number | null } = {},
): Reading => {
	const { since = stale(6 * 60), ...rest } = over;
	return {
		now: NOW,
		main: "a".repeat(40),
		movedAt: NOW - 10 * MIN,
		gauge: gauge(since),
		clock: { floor: NOW - 24 * 60 * MIN, wakes: [] },
		heartbeat: { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: null },
		alive: () => false,
		owed: 0,
		held: { kind: "none" },
		...rest,
	};
};

const found = (over: Parameters<typeof reading>[0] = {}) =>
	stallFindings(reading(over));

const tags = (over: Parameters<typeof reading>[0]) =>
	found(over).map((f) => f.tag);

describe("readHeldExit (#5436)", () => {
	let root = "";
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "landing-stall-"));
	});
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

	const at = (min: number) => new Date(NOW - min * MIN).toISOString();
	const log = (...lines: string[]) => {
		const dir = path.join(root, ".claude", "tmp", "markers");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, ".lander.log"), `${lines.join("\n")}\n`);
	};

	it("reads the newest run end where held, passing over a lock's turn-away", () => {
		log(
			`${at(30)} exit no queue ref waits`,
			`${at(20)} merge-members onto m0: queue/a`,
			`${at(10)} exit held: main is stale`,
			`${at(5)} exit another lander holds the lock`,
		);
		expect(readHeldExit(root, NOW)).toEqual({
			kind: "held",
			at: NOW - 10 * MIN,
			reason: "main is stale",
		});
	});

	it("reads none where a later run ended unheld, or the held end is over a day old", () => {
		log(
			`${at(30)} exit held: main is stale`,
			`${at(5)} exit no queue ref waits`,
		);
		expect(readHeldExit(root, NOW)).toEqual({ kind: "none" });
		log(`${at(25 * 60)} exit held: main is stale`);
		expect(readHeldExit(root, NOW)).toEqual({ kind: "none" });
	});

	it("reads an unreadable log as unread, never throwing", () => {
		fs.mkdirSync(path.join(root, ".claude", "tmp", "markers", ".lander.log"), {
			recursive: true,
		});
		expect(readHeldExit(root, NOW).kind).toBe("unread");
	});
});

describe("the stall clock counts up time across freezes (#5612)", () => {
	let file = "";
	beforeEach(() => {
		file = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "landing-stall-")),
			".machine-wake.json",
		);
	});
	afterEach(() =>
		fs.rmSync(path.dirname(file), { recursive: true, force: true }),
	);

	const Boot = NOW - 48 * 60 * MIN;
	const ago = (min: number) => NOW - min * MIN;
	const readAt = (...rows: [number, number][]) => {
		let clock = {
			floor: 0,
			wakes: [] as { from: number; to: number; frozen: number }[],
		};
		for (const [at, frozen] of rows)
			clock = recordWake(file, {
				startedAt: Boot + frozen * MIN,
				now: at,
				bootId: "b1",
			});
		return clock;
	};
	const stalled = (since: number, clock: Reading["clock"], now = NOW) =>
		stallFindings(reading({ now, since, movedAt: ago(10 * 60), clock })).filter(
			(f) => f.tag === "LANDING-STALLED",
		);

	it("reports no stall at 3 h of wall clock across two 30 min freezes, and one past 2 h of up time", () => {
		const rows: [number, number][] = [
			[ago(4 * 60), 0],
			[ago(180), 0],
			[ago(120), 30],
			[ago(60), 60],
			[NOW, 60],
		];
		expect(stalled(ago(180), readAt(...rows))).toEqual([]);
		const later = NOW + MIN;
		const f = stalled(ago(180), readAt([later, 60]), later);
		expect(f.map((x) => x.line)).toEqual([
			`main has not moved since ${new Date(ago(600)).toISOString()}, over 120 min of up time, not counting 60 min the machine was frozen, with queue/fix-it bbbbbbbbb waiting since ${new Date(ago(180)).toISOString()}`,
		]);
	});

	it("reports a stall where a freeze falls inside every 1 h 50 min window, once up time passes 2 h", () => {
		const since = ago(4 * 110);
		const window = (n: number): [number, number] => [
			since + n * 110 * MIN,
			n * 10,
		];
		readAt([ago(8 * 60), 0], window(0));
		expect(stalled(since, readAt(window(1)), window(1)[0])).toEqual([]);
		expect(stalled(since, readAt(window(2)), window(2)[0])).toHaveLength(1);
		const clock = readAt(window(3), window(4));
		expect(stalled(since, clock).map((f) => f.line)).toEqual([
			expect.stringContaining("not counting 40 min the machine was frozen"),
		]);
	});

	it("subtracts nothing for a freeze that ended before the oldest wait began", () => {
		const since = ago(125);
		const clock = readAt([ago(200), 0], [ago(130), 30], [NOW, 30]);
		expect(stalled(since, clock).map((f) => f.line)).toEqual([
			expect.not.stringContaining("frozen"),
		]);
	});

	it("counts a freeze whose readings bracket the wait's start as inside it, no longer than the part after the start", () => {
		const since = ago(140);
		expect(
			stalled(since, readAt([ago(200), 0], [ago(100), 30], [NOW, 30])),
		).toEqual([]);
		fs.rmSync(file);
		expect(
			stalled(since, readAt([ago(200), 0], [ago(130), 30], [NOW, 30])),
		).toHaveLength(1);
	});

	it("restarts the clock at boot where the machine rebooted after the wait began (#4055)", () => {
		const since = ago(5 * 60);
		readAt([ago(6 * 60), 0], [ago(4 * 60), 0]);
		const boot = ago(119);
		const next = { startedAt: boot, bootId: "b2" };
		const clock = recordWake(file, { ...next, now: NOW });
		expect(clock).toEqual({ floor: boot, wakes: [] });
		expect(stalled(since, clock)).toEqual([]);
		const later = NOW + 2 * MIN;
		expect(
			stalled(since, recordWake(file, { ...next, now: later }), later),
		).toHaveLength(1);
	});

	it("reads a freeze longer than the boot's up time as a freeze, not a reboot, and floors it at the reading where no boot id reads", () => {
		const boot = ago(421);
		const since = boot + 120 * MIN;
		const read = (now: number, frozen: number, bootId: string | null) =>
			recordWake(file, { startedAt: boot + frozen * MIN, now, bootId });
		read(boot + 180 * MIN, 0, "b1");
		const clock = read(NOW, 240, "b1");
		expect(clock.wakes).toEqual([
			{ from: boot + 180 * MIN, to: NOW, frozen: 240 * MIN },
		]);
		expect(stalled(since, clock)).toEqual([]);
		fs.rmSync(file);
		read(boot + 180 * MIN, 0, null);
		expect(read(NOW, 240, null)).toEqual({ floor: NOW, wakes: [] });
	});

	it("keeps the marker's wake history where the marker will not write", () => {
		readAt([ago(200), 0], [ago(100), 30]);
		fs.chmodSync(path.dirname(file), 0o555);
		try {
			expect(readAt([NOW, 30]).wakes).toEqual([
				{ from: ago(200), to: ago(100), frozen: 30 * MIN },
			]);
		} finally {
			fs.chmodSync(path.dirname(file), 0o755);
		}
	});

	it("reads an old-shape, corrupt or absent marker without throwing, as the clock floored at the last wake", () => {
		const at = { startedAt: Boot, now: NOW, bootId: "b1" };
		expect(recordWake(file, at)).toEqual({ floor: Boot, wakes: [] });
		fs.writeFileSync(file, "{not json");
		expect(recordWake(file, at)).toEqual({ floor: Boot, wakes: [] });
		fs.writeFileSync(
			file,
			JSON.stringify({ startedAt: Boot, wokeAt: ago(90) }),
		);
		expect(recordWake(file, at)).toEqual({ floor: ago(90), wakes: [] });
		fs.writeFileSync(
			file,
			JSON.stringify({ startedAt: Boot - 60 * MIN, wokeAt: ago(90) }),
		);
		expect(recordWake(file, at)).toEqual({ floor: NOW, wakes: [] });
		expect(recordWake(file, { ...at, now: NOW + MIN })).toEqual({
			floor: NOW,
			wakes: [],
		});
	});

	it("keeps the newest 64 wakes, flooring the clock at the last one it drops", () => {
		const rows: [number, number][] = Array.from({ length: 72 }, (_, i) => [
			ago(72 * 30 - i * 30),
			i * 10,
		]);
		const clock = readAt(...rows);
		expect(clock.wakes).toHaveLength(64);
		expect(clock.floor).toBe(rows[7]?.[0]);
	});
});

describe("stallFindings", () => {
	it("names a held lander run while a queue ref waits, and none where nothing waits (#5436)", () => {
		const held = {
			kind: "held",
			at: NOW - MIN,
			reason: "main is stale",
		} as const;
		expect(found({ held })).toEqual([
			{
				tag: "LANDER-HELD",
				line: `the queue lander's last run, at ${new Date(NOW - MIN).toISOString()}, ended held: main is stale`,
			},
		]);
		expect(tags({ held, since: null })).toEqual([]);
	});

	it("names a lander log that would not read, so a hold may go unseen (#5436)", () => {
		expect(found({ held: { kind: "unread", fault: "EISDIR" } })).toEqual([
			{
				tag: "LANDER-LOG-UNREAD",
				line: "the queue lander's log would not read, so a held run end goes unseen: EISDIR",
			},
		]);
	});

	it("warns of a stall where main has not moved for 2 h with a queue ref waiting, naming both", () => {
		const f = found({ movedAt: stale(1) });
		expect(f.map((x) => x.tag)).toEqual(["LANDING-STALLED"]);
		expect(f[0]?.line).toBe(
			`main has not moved since 2026-10-21T09:59:00.000Z, over 120 min, with queue/fix-it bbbbbbbbb waiting since ${new Date(stale(6 * 60)).toISOString()}`,
		);
	});

	it("warns of no stall where main moved within 2 h", () => {
		expect(tags({})).toEqual([]);
	});

	it("warns of no stall where the oldest ref was pushed within 2 h, though main has stood for hours (#3303)", () => {
		expect(tags({ movedAt: stale(6 * 60), since: NOW - 4 * MIN })).toEqual([]);
	});

	it("warns of no stall where the machine woke within 2 h, however long main and the ref have stood (#4055)", () => {
		expect(
			tags({
				movedAt: stale(6 * 60),
				clock: { floor: NOW - 4 * MIN, wakes: [] },
			}),
		).toEqual([]);
	});

	it("warns of a stall where it has lasted over 2 h since it woke (#4055)", () => {
		expect(
			tags({ movedAt: stale(6 * 60), clock: { floor: stale(1), wakes: [] } }),
		).toEqual(["LANDING-STALLED"]);
	});

	it("warns of nothing where no queue ref waits, however long main has stood and whatever the lander", () => {
		expect(tags({ since: null, movedAt: stale(60), heartbeat: null })).toEqual(
			[],
		);
	});

	it("warns of no stall where the remote has no main", () => {
		expect(tags({ main: null, movedAt: null, alive: () => true })).toEqual([]);
	});

	it("warns of a dead lander where a queue ref waits and the heartbeat is stale", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		const f = found({ heartbeat: { pid: 7, at, batch: null } });
		expect(f.map((x) => x.tag)).toEqual(["LANDER-DEAD"]);
		expect(f[0]?.line).toBe(
			`queue/fix-it bbbbbbbbb waits and no queue lander is running, its heartbeat last written ${at}`,
		);
	});

	it("warns of a dead lander where there is no heartbeat at all", () => {
		expect(tags({ heartbeat: null })).toEqual(["LANDER-DEAD"]);
	});

	it("reads a stale heartbeat whose pid still runs as a lander inside a call, not a dead one", () => {
		const at = new Date(NOW - STALE_MS - MIN).toISOString();
		expect(
			tags({ heartbeat: { pid: 7, at, batch: null }, alive: () => true }),
		).toEqual([]);
	});
});

describe("the lander's identity and hang (#5606)", () => {
	const ago = (ms: number) => new Date(NOW - ms).toISOString();
	const ownBeat = (over: object = {}, at = ago(STALE_MS + MIN)) => ({
		pid: process.pid,
		procStart: readProcStartOf(process.pid),
		bootId: readCurrentBootId(),
		at,
		batch: null,
		...over,
	});
	const readingOwnProc = (heartbeat: ReturnType<typeof ownBeat>, over = {}) =>
		reading({ heartbeat, alive: holderAlive, ...over });

	it("reads a stale beat whose running pid started at another time as a dead lander, and starts one", () => {
		const r = readingOwnProc(ownBeat({ procStart: "1" }));
		expect(stallFindings(r).map((f) => f.tag)).toEqual(["LANDER-DEAD"]);
		expect(supervision(r).start).toBe(true);
	});

	it("reads a stale beat written in another boot as a dead lander", () => {
		expect(
			stallFindings(readingOwnProc(ownBeat({ bootId: "another-boot" }))).map(
				(f) => f.tag,
			),
		).toEqual(["LANDER-DEAD"]);
	});

	it.each([
		["a push", PUSH_TIMEOUT_MS],
		["an install", INSTALL_TIMEOUT_MS],
		["a gate run", GATED_COMMIT_TIMEOUT_MS + HOOK_GRACE_MS],
		[
			"a registry check between two throwaway trees",
			GATED_COMMIT_TIMEOUT_MS + 2 * LANDER_GIT_TIMEOUT_MS,
		],
		["a filing", FILING_TIMEOUT_MS],
		["a body refresh", 2 * GH_TIMEOUT_MS],
		["a remote heads read", 3 * LANDER_GIT_TIMEOUT_MS],
		["a guard-code adoption", 2 * ADOPT_WAIT_MS],
	])(
		"reads the lander's beat as old as %s, its longest gap between beats, as a lander inside a call (#5644)",
		(_gap, ms) => {
			const r = readingOwnProc(ownBeat({}, ago(ms + MIN / 2)));
			expect(stallFindings(r)).toEqual([]);
			expect(supervision(r).start).toBe(false);
		},
	);

	it("reads the lander's beat older than the hang threshold as hung, starting none and filing the stall ticket", () => {
		const r = readingOwnProc(ownBeat({}, ago(HUNG_MS + MIN)), {
			movedAt: stale(1),
		});
		expect(stallFindings(r)).toEqual([
			expect.objectContaining({ tag: "LANDING-STALLED" }),
			{
				tag: "LANDER-HUNG",
				line: `queue/fix-it bbbbbbbbb waits and the queue lander, pid ${process.pid}, still runs but last beat ${HUNG_MS / MIN + 1} min ago, past the ${HUNG_MS / MIN} min its longest step between beats can take`,
			},
		]);
		expect(supervision(r)).toEqual({
			start: false,
			ticket: { waiting: `queue/fix-it at ${Q}`, movedAt: stale(1) },
		});
	});
});

describe("supervision", () => {
	const live = { pid: 7, at: new Date(NOW - MIN).toISOString(), batch: null };
	const ticket = { waiting: `queue/fix-it at ${Q}`, movedAt: stale(1) };

	it("starts a lander and files no ticket for a dead lander while main moved within 2 h", () => {
		expect(supervision(reading({ heartbeat: null }))).toEqual({
			start: true,
			ticket: null,
		});
	});

	it("starts a lander for a waiting ref on a fresh beat whose pid has exited", () => {
		expect(supervision(reading({ heartbeat: live }))).toEqual({
			start: true,
			ticket: null,
		});
	});

	it("starts none where no queue ref waits and no drop is owed a decision", () => {
		expect(supervision(reading({ since: null, heartbeat: null }))).toEqual({
			start: false,
			ticket: null,
		});
	});

	it("starts a lander with no queue ref waiting where a drop is owed a decision, and none while a lander runs (#4950)", () => {
		const owed = { since: null, owed: 1 };

		expect(supervision(reading({ ...owed, heartbeat: null }))).toEqual({
			start: true,
			ticket: null,
		});
		expect(
			supervision(reading({ ...owed, heartbeat: live, alive: () => true })),
		).toEqual({ start: false, ticket: null });
	});

	it("files the stall ticket for a dead lander where main has stood 2 h, as a lander failing on every start leaves it", () => {
		expect(
			supervision(reading({ heartbeat: null, movedAt: stale(1) })),
		).toEqual({ start: true, ticket });
	});

	it("files the stall ticket where a running lander has not moved main for 2 h, starting none beside it", () => {
		expect(
			supervision(
				reading({ heartbeat: live, alive: () => true, movedAt: stale(1) }),
			),
		).toEqual({ start: false, ticket });
	});

	it("does nothing where a running lander moved main within 2 h", () => {
		expect(
			supervision(reading({ heartbeat: live, alive: () => true })),
		).toEqual({ start: false, ticket: null });
	});

	it("files no ticket on a stall whose lander is between runs on a fresh beat", () => {
		expect(
			supervision(reading({ heartbeat: live, movedAt: stale(1) })),
		).toEqual({ start: true, ticket: null });
	});
});
