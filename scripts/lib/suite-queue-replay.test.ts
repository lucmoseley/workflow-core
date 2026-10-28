// @vitest-environment node
/*
 * suite-queue-replay.test.ts — the queue-wait replay (#3060). Break it
 * and a firing of the alarm is answered with the wrong limb: a memory hold read
 * as a turn, a count hold blamed on the wrong slot holder, or a session's
 * side-by-side waits counted twice.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLogs, render, replay } from "./suite-queue-replay";

const MIN = 60_000;
const T0 = Date.parse("2026-10-27T00:00:00Z");
const iso = (t: number) => new Date(t).toISOString();

interface Waiter {
	from: number;
	to: number;
	reason?: string;
	kind?: string;
	session?: string | null;
	pid?: number;
	slotFree?: boolean;
	passed?: number;
}
const exit = (w: Waiter, i: number) => ({
	reason: "refused",
	kind: "named",
	session: `s-${i}`,
	pid: 100 + i,
	empty: false,
	...w,
	at: iso(T0 + w.to * MIN),
	waitS: (w.to - w.from) * 60,
});

interface Run {
	from: number;
	to: number;
	kind?: string;
	session?: string | null;
	wholeSlot?: boolean | null;
	resolvedFiles?: number | null;
	sha?: string;
}
const run = (r: Run) => ({
	kind: "named",
	session: null,
	wholeSlot: false,
	resolvedFiles: 1,
	verdict: "green",
	sha: "abcdef123",
	modulesRun: null,
	modulesTotal: null,
	...r,
	st: T0 + r.from * MIN,
	en: T0 + r.to * MIN,
});

const window = (until = 60, eras: { label: string; from: number }[] = []) => ({
	since: T0,
	until: T0 + until * MIN,
	eras: eras.map((e) => ({ label: e.label, from: T0 + e.from * MIN })),
	memTotalMb: 10_000,
	loadCeiling: 48,
});

/** memwatch blocks over minutes [from, to) of the window. */
const blocks = (from: number, to: number, used: number, load = 1) =>
	Array.from(
		{ length: to - from },
		(_, i) => [Math.floor(T0 / MIN) + from + i, { used, load }] as const,
	);

function replayOf({
	waiters = [] as Waiter[],
	runs = [] as Run[],
	mem = [] as (readonly [number, { used: number; load: number }])[],
	parents = [] as { t: number; sha: string }[],
	until = 60,
	eras = [] as { label: string; from: number }[],
} = {}) {
	return replay(
		{
			exits: waiters.map(exit),
			runs: runs.map(run),
			mem: new Map(mem),
			parents,
			unread: { absent: [], unparsed: 0 },
		},
		window(until, eras),
	);
}
const hoursOf = (m: Map<string, number>) => Object.fromEntries(m);

describe("the passes the waiters recorded (#3115)", () => {
	it("tallies the exit lines that count their passes, apart from the model", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, slotFree: true, reason: "opened", passed: 2 },
				{ from: 0, to: 5, slotFree: true, reason: "opened", passed: 0 },
				{ from: 0, to: 5, slotFree: false, reason: "opened" },
			],
		});
		expect(r.passes).toEqual({ counted: 2, passing: 1, passed: 2 });
		expect(render(r, window())).toContain(
			"Recorded passes: 1 of the 2 waits whose exit line counts its passes opened their turn past 2 older part waiter(s)",
		);
	});

	it("samples the opened part waits the memory limb held, the age bound's input", () => {
		const r = replayOf({
			mem: blocks(0, 5, 9000),
			waiters: [
				{ from: 0, to: 10, slotFree: true, reason: "opened" },
				{ from: 6, to: 8, slotFree: true, reason: "opened" },
				{ from: 0, to: 4, slotFree: true, reason: "refused" },
				{ from: 0, to: 3, slotFree: false, reason: "opened" },
				{ from: 0, to: 2, slotFree: true, reason: "opened", kind: "tsc" },
			],
		});
		expect(r.memoryHeldPart).toEqual([600]);
		expect(render(r, window())).toContain(
			"1 opened part waits the memory limb held at some tick, wait p50 600 s, p90 600 s",
		);
	});

	it("says where no line counts its passes", () => {
		const r = replayOf({ waiters: [{ from: 0, to: 5, reason: "opened" }] });
		expect(render(r, window())).toContain(
			"no exit line in the window counts its passes",
		);
	});
});

describe("the limbs, in the gate's order", () => {
	it("holds a whole waiter on the count while a whole run has the slot, and names the holder", () => {
		const r = replayOf({
			runs: [{ from: 0, to: 20, kind: "lander", wholeSlot: true }],
			waiters: [{ from: 0, to: 10, kind: "bare", slotFree: false }],
		});
		expect(hoursOf(r.limb)).toEqual({ count: 600 });
		expect(hoursOf(r.holder)).toEqual({ "lander push gate": 600 });
		expect(hoursOf(r.holderSession)).toEqual({ lander: 600 });
	});

	it("names a lander whole run its parent confirm where the lander logged one for its sha", () => {
		const r = replayOf({
			runs: [{ from: 0, to: 20, kind: "lander" }],
			waiters: [{ from: 0, to: 10, slotFree: false }],
			parents: [{ t: T0 - MIN, sha: "abcdef123" }],
		});
		expect(hoursOf(r.holder)).toEqual({ "lander parent confirm": 600 });
	});

	it("holds a part waiter on memory where memwatch's available is under its rung, and only in minutes with a block", () => {
		const r = replayOf({
			waiters: [{ from: 0, to: 10, slotFree: true }],
			mem: blocks(0, 5, 9000),
		});
		expect(hoursOf(r.limb)).toEqual({ memory: 300, open: 300 });
		expect(r.memMinutes).toBe(5);
	});

	it("charges the rung for every running worker, not the waiter's own alone", () => {
		const held = (used: number) =>
			replayOf({
				runs: [{ from: 0, to: 10, resolvedFiles: 5, session: "x" }],
				waiters: [{ from: 0, to: 10, slotFree: true }],
				mem: blocks(0, 10, used),
			}).limb.get("memory") ?? 0;
		expect(held(7500)).toBe(600);
		expect(held(5000)).toBe(0);
	});

	it("holds a part waiter behind an older part waiter, and a whole one behind any older waiter", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, slotFree: true },
				{ from: 5, to: 10, slotFree: true },
				{ from: 6, to: 10, kind: "bare", slotFree: false },
			],
		});
		expect(hoursOf(r.limbClass)).toEqual({
			"open / part": 600,
			"fifo-part / part": 300,
			"fifo-whole / whole": 240,
		});
	});

	it("holds a waiter while another is admitted but not yet spawned", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, slotFree: true },
				{ from: 4, to: 5, slotFree: true, reason: "opened", session: "x" },
			],
			runs: [{ from: 6, to: 8, session: "x" }],
		});
		expect(r.matched).toBe(1);
		expect(r.gaps).toEqual([60]);
		expect(r.limbClass.get("admitted / part")).toBe(60);
	});

	it("holds on load at the ceiling where nothing earlier holds", () => {
		const r = replayOf({
			waiters: [{ from: 0, to: 10, slotFree: true }],
			mem: blocks(0, 10, 1000, 48),
		});
		expect(hoursOf(r.limb)).toEqual({ load: 600 });
	});

	it("tallies each later limb that held the same waiter as well as its first", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, slotFree: true },
				{ from: 5, to: 10, slotFree: true },
			],
			mem: blocks(0, 10, 9000, 48),
		});
		expect(hoursOf(r.limb)).toEqual({ memory: 900 });
		expect(hoursOf(r.limbAlso)).toEqual({
			"memory / fifo-part": 120,
			"memory / load": 900,
		});
	});

	it("lets a part waiter pass an older one the memory rung holds, until that one is 8 minutes old (#3058)", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, slotFree: true },
				{ from: 5, to: 10, slotFree: true },
			],
			mem: blocks(0, 10, 9000),
		});
		expect(hoursOf(r.limbAlso)).toEqual({ "memory / fifo-part": 120 });
	});
});

describe("matching a wait to its run", () => {
	it("takes the same session's run spawned within 900 s, and weighs the waiter by it", () => {
		const r = replayOf({
			waiters: [{ from: 0, to: 5, reason: "opened", session: "a" }],
			runs: [
				{ from: 6, to: 20, session: "b", wholeSlot: true },
				{ from: 7, to: 20, session: "a", wholeSlot: true, resolvedFiles: 700 },
			],
		});
		expect(r.matched).toBe(1);
		expect(hoursOf(r.limbClass)).toEqual({ "open / whole": 300 });
	});

	it("classes an unmatched waiter by its kind, marked unsure", () => {
		const r = replayOf({
			waiters: [
				{ from: 1, to: 5, kind: "bare" },
				{ from: 0, to: 5, kind: "named", session: "z" },
			],
		});
		expect([...r.limbClass.keys()].sort()).toEqual([
			"fifo-whole / whole?",
			"open / part?",
		]);
	});
});

describe("the window", () => {
	it("counts only the part of a wait inside it, and no exit logged after it", () => {
		const r = replayOf({
			until: 10,
			waiters: [
				{ from: -5, to: 5, slotFree: true },
				{ from: 8, to: 12, slotFree: true },
			],
		});
		expect(r.queued).toBe(1);
		expect(r.waitS).toBe(300);
		expect(r.limb.get("open")).toBe(300);
	});

	it("splits the limbs and the wait at each era, the window's start before the first", () => {
		const r = replayOf({
			waiters: [{ from: 0, to: 20, slotFree: true }],
			eras: [{ label: "after #1", from: 15 }],
		});
		expect(r.eraWait.map((e) => [e.label, e.waitS])).toEqual([
			["window start", 900],
			["after #1", 300],
		]);
		expect(hoursOf(r.limbEra.get("after #1") ?? new Map())).toEqual({
			open: 300,
		});
	});
});

it("sums a session's waits and their union apart", () => {
	const r = replayOf({
		waiters: [
			{ from: 0, to: 10, session: "a", slotFree: true },
			{ from: 5, to: 15, session: "a", slotFree: true },
		],
	});
	expect(r.sessions).toHaveLength(1);
	expect(r.sessions[0]).toMatchObject({ waits: 2, sum: 1200, union: 900 });
	expect(r.peak.n).toBe(2);
});

describe("reading the logs", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-queue-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const jsonl = (file: string, rows: object[]) =>
		fs.writeFileSync(
			path.join(dir, file),
			rows.map((r) => JSON.stringify(r)).join("\n"),
		);
	/* memwatch writes local time. */
	const local = (t: number) => {
		const d = new Date(t);
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	};

	it("reads every store and prints the reading with its limits", () => {
		jsonl(".suite-queue-exits.jsonl", [
			exit({ from: 0, to: 10, slotFree: false, kind: "bare" }, 1),
		]);
		fs.appendFileSync(
			path.join(dir, ".suite-queue-exits.jsonl"),
			"\nnot json\n",
		);
		jsonl(".test-runs.jsonl", [
			{
				startedAt: iso(T0),
				at: iso(T0 + 20 * MIN),
				kind: "lander",
				verdict: "green",
				suite: "vitest",
				session: null,
				sha: "abcdef1234567",
			},
			{
				startedAt: iso(T0),
				at: iso(T0 + MIN),
				kind: "pytest",
				suite: "pytest",
				session: "p",
				sha: "x",
			},
		]);
		const memwatch = path.join(dir, "memwatch.log");
		fs.writeFileSync(
			memwatch,
			[
				`=== ${local(T0 + 30 * MIN)} 9500MB used | cpu: 700% busy of 800% (sys 1%), load 3.10 | claude sessions: 1 ===`,
				"  1234 node vitest",
				`=== ${local(T0)} 9000MB used ===`,
			].join("\n"),
		);
		fs.writeFileSync(
			path.join(dir, ".lander.log"),
			`${iso(T0 - MIN)} rerun abcdef1234567 (parent): the whole suite on landing\n`,
		);
		const logs = readLogs({
			markers: dir,
			memwatch: [memwatch, path.join(dir, "absent.log")],
			since: T0,
			until: T0 + 60 * MIN,
		});
		expect(logs.exits).toHaveLength(1);
		expect(logs.runs).toHaveLength(1);
		expect([...logs.mem]).toEqual([
			[Math.floor(T0 / MIN) + 30, { used: 9500, load: 3.1 }],
		]);
		expect(logs.parents).toEqual([{ t: T0 - MIN, sha: "abcdef123" }]);
		expect(logs.unread.unparsed).toBe(1);
		expect(logs.unread.absent).toContain(path.join(dir, "absent.log"));

		const w = window();
		const out = render(replay(logs, w), w);
		expect(out).toContain("| count | 0.17 |");
		expect(out).toContain("| lander parent confirm | 0.17 |");
		expect(out).toContain(
			"memwatch wrote a block in 1 of the window's 60 minutes",
		);
		expect(out).toContain("lander's own queue wait is not in the exits log");
		expect(out).toContain("1 log line(s) would not parse");
		expect(out).toMatch(/Not found, so read as empty: .*absent\.log/);
	});

	it("weighs a run logged before `resolvedFiles` by its vitest marker", () => {
		const st = Date.parse("2026-10-25T09:00:00Z");
		jsonl(".test-runs.jsonl", [
			{
				startedAt: iso(st),
				at: iso(st + MIN),
				kind: "named",
				verdict: "green",
				suite: "vitest",
				session: "a",
				sha: "s",
			},
		]);
		jsonl(".test-pass-markers.archive.jsonl", [
			{
				at: iso(st + MIN),
				sessionId: "a",
				startedAt: iso(st + 1000),
				scope: { modulesRun: 4, modulesTotal: 600 },
			},
		]);
		const logs = readLogs({
			markers: dir,
			memwatch: [],
			since: st,
			until: st + 10 * MIN,
		});
		expect(logs.runs[0]).toMatchObject({ modulesRun: 4, modulesTotal: 600 });
	});
});
