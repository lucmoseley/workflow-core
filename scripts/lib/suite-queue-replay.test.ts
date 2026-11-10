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
import { chargeMb } from "./launch-charge";
import {
	DRAW_MARGIN_MB,
	rungMb,
	suiteRungMb,
	WHOLE_SUITE_MAX,
} from "./suite-ladder";
import { PART_PASS_AGE_MS, turnOf } from "./suite-queue";
import { readLogs, render, replay } from "./suite-queue-replay";

const peak5 = chargeMb({ kind: "tsc", major: 5 });
const peak7 = chargeMb({ kind: "tsc", major: 7 });
/* A logged line with no `chargeMb` ran on TypeScript 5. */
const rung5 = rungMb(peak5);

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
	climbMb?: number;
	chargeMb?: number;
	peerS?: number;
	limb?: string;
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
}
const run = (r: Run) => ({
	kind: "named",
	session: null,
	wholeSlot: false,
	resolvedFiles: 1,
	verdict: "green",
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
		(_, i) =>
			[Math.floor(T0 / MIN) + from + i, { used, load, tsc: 0 }] as const,
	);
/** The same, each listing a running `tsc`. */
const tscBlocks = (from: number, to: number, used: number, load = 1) =>
	blocks(from, to, used, load).map(([k, b]) => [k, { ...b, tsc: 1 }] as const);

function replayOf({
	waiters = [] as Waiter[],
	runs = [] as Run[],
	mem = [] as (readonly [
		number,
		{ used: number; load: number; tsc: number },
	])[],
	until = 60,
	eras = [] as { label: string; from: number }[],
} = {}) {
	return replay(
		{
			exits: waiters.map(exit),
			runs: runs.map(run),
			mem: new Map(mem),
			windows: new Map(),
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
			`1 opened part waits the memory limb held at some tick, wait p50 600 s, p90 600 s, max 600 s, against a bound of ${PART_PASS_AGE_MS / 1000} s now.`,
		);
	});

	it("says where no line counts its passes", () => {
		const r = replayOf({ waiters: [{ from: 0, to: 5, reason: "opened" }] });
		expect(render(r, window())).toContain(
			"no exit line in the window counts its passes",
		);
	});
});

describe("the peer holds the waiters recorded (#4765)", () => {
	it("tallies `tsc` and suite exit lines' peer seconds and bound refusals apart from the model", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 40, kind: "tsc", peerS: 2400, limb: "peer" },
				{ from: 0, to: 5, kind: "tsc", reason: "opened", peerS: 60 },
				{ from: 0, to: 5, kind: "tsc", reason: "opened" },
				{ from: 0, to: 5, slotFree: true, reason: "opened", peerS: 30 },
			],
		});
		expect(r.peers).toEqual({
			tsc: { held: 2, heldS: 2460, atBound: 1 },
			suite: { held: 1, heldS: 30, atBound: 0 },
		});
		const said = render(r, window());
		expect(said).toContain(
			"Recorded peer holds, tsc waits: 2 held on an older waiter in the other queue the climb charge holds, 0.68 h, 1 still held at the bound (#4765).",
		);
		expect(said).toContain(
			"Recorded peer holds, suite waits: 1 held on an older waiter in the other queue the climb charge holds, 0.01 h, 0 still held at the bound (#4765).",
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
			"memory / fifo-part": (10 * MIN - PART_PASS_AGE_MS) / 1000,
			"memory / load": 900,
		});
	});
});

describe("a `tsc` wait, on the type-check slot's gate (#3163)", () => {
	it("is held on a `tsc` running, then its own rung, never on a suite limb, in the Era table too", () => {
		const cfg = {
			runs: [{ from: 0, to: 10, kind: "lander", wholeSlot: true }],
			waiters: [
				{ from: 0, to: 10, kind: "bare", slotFree: false },
				{ from: 1, to: 10, kind: "tsc", reason: "opened", session: null },
			],
			mem: [...tscBlocks(1, 4, 1000, 48), ...blocks(4, 7, 8000, 48)],
		};
		const r = replayOf(cfg);
		expect(r.matched).toBe(0);
		expect(r.matchable).toBe(0);
		expect(hoursOf(r.limbClass)).toEqual({
			"count / whole": 600,
			"tsc-count / tsc": 180,
			"tsc-memory / tsc": 180,
			"open / tsc": 180,
		});
		expect(render(r, window())).toContain("| tsc-count | 0.05 |");
		const eras = [{ label: "later", from: 4 }];
		const out = render(replayOf({ ...cfg, eras }), window(60, eras));
		expect(out).toContain(
			"| tsc-count | tsc-memory | climb | windows | fifo-whole | fifo-part | tsc-fifo |",
		);
		expect(out).toContain(
			"| window start | 0.07 | 0.12 | 0.07 | — | 0.05 | — | — | — | — | — | — | — | — | — |",
		);
	});

	/* 4,000 MB available against the 3,150 MB `tsc` rung, which clears it alone
	 * and not less the 2,000 MB the exit line recorded (#3806). */
	it("names the climb limb where the charge held a wait the reading clears, ahead of the `tsc` fifo", () => {
		const r = replayOf({
			waiters: [
				{ from: 0, to: 10, kind: "tsc" },
				{ from: 0, to: 10, kind: "tsc", climbMb: 2000 },
			],
			mem: blocks(0, 5, 6000),
		});
		expect(hoursOf(r.limb)).toMatchObject({ climb: 300 });
		expect(render(r, window())).toContain("| climb | 0.08 |");
	});

	it("reads no climb where the reading alone is under the rung, or a charge leaves it clear", () => {
		const under = replayOf({
			waiters: [{ from: 0, to: 5, kind: "tsc", climbMb: 2000 }],
			mem: blocks(0, 5, 8000),
		});
		expect(hoursOf(under.limb)).toEqual({ "tsc-memory": 300 });
		const clear = replayOf({
			waiters: [{ from: 0, to: 5, kind: "tsc", climbMb: 100 }],
			mem: blocks(0, 5, 6000),
		});
		expect(hoursOf(clear.limb)).toEqual({ open: 300 });
	});

	/* Available memory between the two compilers' rungs: a logged TypeScript 7
	 * type-check clears its rung, a 5.x one, charged 2,045 MB or logged before
	 * #4892 with no charge, is held on its own (#4892). A killed line is read by
	 * its charge alone (#4921). */
	it("charges each logged type-check the peak of the compiler it ran", () => {
		const between = 10_000 - (rungMb(peak7) + rung5) / 2;
		const limbsOf = (logged?: number, reason = "refused") =>
			hoursOf(
				replayOf({
					waiters: [
						{
							from: 0,
							to: 5,
							kind: "tsc",
							reason,
							...(logged ? { chargeMb: logged } : {}),
						},
					],
					mem: blocks(0, 5, between),
				}).limb,
			);
		expect(limbsOf(peak7)).toEqual({ open: 300 });
		expect(limbsOf(peak7, "killed")).toEqual({ open: 300 });
		expect(limbsOf(peak5)).toEqual({ "tsc-memory": 300 });
		expect(limbsOf()).toEqual({ "tsc-memory": 300 });
	});

	it("names the climb limb on a suite waiter too", () => {
		const r = replayOf({
			waiters: [{ from: 0, to: 5, slotFree: true, climbMb: 4500 }],
			mem: blocks(0, 5, 5000),
		});
		expect(hoursOf(r.limb)).toEqual({ climb: 300 });
	});
});

/* Each pair of waits is staged in the logs and the younger's limbs read back
 * per tick; what they should be is asked of `turnOf` itself, so a change to the
 * gate's turn reaches the replay with no edit here (#4260). The older wait's
 * exit line charges a 9,000 MB climb, which its rung cannot clear: the
 * `memoryHeld` stamp the gate would read. */
describe("the turn limbs, the gate's own turnOf (#4260)", () => {
	const Class = {
		part: { slotFree: true },
		whole: { kind: "bare", slotFree: false },
		tsc: { kind: "tsc" },
	} as const;
	type Cls = keyof typeof Class;
	const pairs = (["part", "whole", "tsc"] as Cls[]).flatMap((older) =>
		(["part", "whole", "tsc"] as Cls[]).flatMap((younger) =>
			[true, false].map((held) => [older, younger, held] as const),
		),
	);
	it.each(pairs)(
		"holds a %s wait's younger %s neighbour as turnOf says, and never the older on it (rung-held: %s)",
		(older, younger, held) => {
			const r = replayOf({
				waiters: [
					{
						from: 0,
						to: 10,
						...Class[older],
						...(held ? { climbMb: 9000 } : {}),
					},
					{ from: 2, to: 10, ...Class[younger] },
				],
				mem: blocks(0, 10, 1000),
			});
			const sameQueue = (older === "tsc") === (younger === "tsc");
			const expected = new Map<string, number>();
			for (let t = T0 + 2 * MIN; t < T0 + 10 * MIN; t += 10_000) {
				const { reasons } = turnOf(
					{
						waiter: younger,
						ahead: sameQueue
							? [
									{
										at: T0,
										part: older === "part",
										spawned: false,
										memoryHeld: held,
									},
								]
							: [],
						admissionOpen: false,
						slots: WHOLE_SUITE_MAX,
						now: t,
					},
					{ partPass: true },
				);
				const limb = reasons[0] ?? "open";
				expected.set(limb, (expected.get(limb) ?? 0) + 10);
			}
			const limbsOf = (session: string) =>
				Object.fromEntries(
					r.sessions.find((s) => s.session === session)?.limbs ?? [],
				);
			if (!held) expect(limbsOf("s-0")).toEqual({ open: 600 });
			const mine = r.sessions.find((s) => s.session === "s-1");
			expect(Object.fromEntries(mine?.limbs ?? [])).toEqual(
				Object.fromEntries(expected),
			);
		},
	);
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

describe("the windows limb, the Windows-memory hold (#4782, #4850)", () => {
	/** The limbs a 4-file head and a 1-file part wait are held on, the two
	 * waits shifted to `at`, Windows reading `mb` free and `pagesIn`. */
	const replayAt = (at: string, mb: number, pagesIn?: number) => {
		const Shift = Date.parse(at) - T0;
		const later = (t: number) => t + Shift;
		const exits = [
			{ from: 0, to: 30, slotFree: true, reason: "timeout" },
			{ from: 2, to: 10, slotFree: true, reason: "opened" },
		].map((waiter, i) => {
			const e = exit(waiter, i);
			return { ...e, at: iso(later(Date.parse(e.at))) };
		});
		const runs = [
			{ from: 30, to: 35, session: "s-0", resolvedFiles: 4 },
			{ from: 10, to: 11, session: "s-1", resolvedFiles: 1 },
		].map((spec) => {
			const x = run(spec);
			return { ...x, st: later(x.st), en: later(x.en) };
		});
		const w = window();
		const r = replay(
			{
				exits,
				runs,
				mem: new Map(),
				windows: new Map(
					Array.from({ length: 60 }, (_, m) => [
						Math.floor(later(T0) / MIN) + m,
						{
							state: "fresh" as const,
							mb,
							ageS: 0,
							...(pagesIn === undefined ? {} : { pagesIn }),
						},
					]),
				),
				unread: { absent: [], unparsed: 0 },
			},
			{ ...w, since: later(w.since), until: later(w.until) },
		);
		return (session: string) =>
			Object.fromEntries(
				r.sessions.find((s) => s.session === session)?.limbs ?? [],
			);
	};

	it("holds a 4-file head on its draw and lets a 1-file part wait that fits pass it, before #4850", () => {
		/* A day after #4557's hold and #4782's pass took effect; 1,500 MB is
		 * under a 4-worker draw plus the margin, over a 1-worker one. */
		const limbsOf = replayAt("2026-11-10T00:00:00Z", 1500);
		expect(limbsOf("s-0")).toEqual({ windows: 1800 });
		expect(limbsOf("s-1")).toEqual({ open: 480 });
	});

	it("holds neither at 1,500 MB free with Windows not paging, from #4850", () => {
		const limbsOf = replayAt("2026-11-11T00:00:00Z", 1500, 1500);
		expect(limbsOf("s-0")).not.toHaveProperty("windows");
		expect(limbsOf("s-1")).not.toHaveProperty("windows");
	});

	it("holds both while Windows pages hard, from #4850", () => {
		const limbsOf = replayAt("2026-11-11T00:00:00Z", 1500, 150_000);
		expect(limbsOf("s-0")).toHaveProperty("windows");
		expect(limbsOf("s-1")).toHaveProperty("windows");
	});

	it("holds a 30-minute wait on it for one 10-minute spell only, from #4850", () => {
		const limbsOf = replayAt("2026-11-11T00:00:00Z", 1500, 150_000);
		expect(limbsOf("s-0").windows).toBe(600);
	});
});

describe("the peer-climb limb, a younger waiter yielding to a climb-held one (#4760, #4799)", () => {
	/* A whole head charged a 1,587 MB climb against its 3,650 MB rung, a
	 * 1-worker run beside it, a `tsc` running, and a younger `tsc` waiting.
	 * Each 10 minutes the head is held on another limb: the climb (4,000 MB
	 * available), the Windows hold (5,500 MB, Windows' 2,100 MB free under
	 * its ~2,300 MB need and the `tsc`'s), then the rung itself (the `tsc`'s
	 * rung available). Outside the middle phase Windows has the `tsc`'s need
	 * free. The head's figures hold for a `tsc` peak of ~1,800 to ~2,500 MB. */
	const head = (at: string, { tsc = 1, wholeSlot = false } = {}) => {
		const base = Date.parse(at);
		const shift = (t: number) => t - T0 + base;
		const minute = (m: number) => Math.floor(base / MIN) + m;
		const used = (m: number) =>
			[6000, 4500, 10_000 - rung5][Math.floor(m / 10)];
		const tscWin = chargeMb({ kind: "tsc" }) + DRAW_MARGIN_MB;
		const win = (m: number) => [tscWin, 2100, tscWin][Math.floor(m / 10)];
		const w = window();
		const r = replay(
			{
				exits: [
					{ from: 0, to: 30, slotFree: false, climbMb: 1587 },
					{ from: 2, to: 30, kind: "tsc", reason: "opened" },
				].map((waiter, i) => {
					const e = exit(waiter, i);
					return { ...e, at: iso(shift(Date.parse(e.at))) };
				}),
				runs: [{ from: 0, to: 30, session: "s-9", wholeSlot }].map((spec) => {
					const x = run(spec);
					return { ...x, st: shift(x.st), en: shift(x.en) };
				}),
				mem: new Map(
					Array.from({ length: 30 }, (_, m) => [
						minute(m),
						{ used: used(m), load: 1, tsc },
					]),
				),
				windows: new Map(
					Array.from({ length: 30 }, (_, m) => [
						minute(m),
						{ state: "fresh" as const, mb: win(m), ageS: 0 },
					]),
				),
				unread: { absent: [], unparsed: 0 },
			},
			{ ...w, since: shift(w.since), until: shift(w.until) },
		);
		return {
			limbsOf: (session: string) =>
				Object.fromEntries(
					r.sessions.find((s) => s.session === session)?.limbs ?? [],
				),
			peerS: r.limbAlso.get("tsc-count / peer-climb") ?? 0,
		};
	};

	it("holds the `tsc` back throughout, the head's stamp kept on the Windows hold and the rung", () => {
		const { limbsOf, peerS } = head("2026-11-10T00:00:00Z");
		expect(limbsOf("s-0")).toEqual({ climb: 600, windows: 600, memory: 600 });
		expect(peerS).toBe(1680);
	});

	it("keeps no stamp where only the head's own queue runs, which charges it nothing", () => {
		const { limbsOf } = head("2026-11-10T00:00:00Z", { tsc: 0 });
		expect(limbsOf("s-1")).toEqual({
			"peer-climb": 480,
			windows: 600,
			open: 600,
		});
	});

	it("stamps no head the count limb holds first", () => {
		const { limbsOf, peerS } = head("2026-11-10T00:00:00Z", {
			wholeSlot: true,
		});
		expect(limbsOf("s-0")).toEqual({ count: 1800 });
		expect(peerS).toBe(0);
	});

	it("lets the `tsc` go once the climb limb clears, before #4799's commit", () => {
		expect(head("2026-11-09T09:00:00Z").peerS).toBe(480);
	});

	it("reads no peer-climb before #4760's commit", () => {
		expect(head("2026-11-09T07:00:00Z").peerS).toBe(0);
	});
});

describe("the pass past a head the memory rung holds at rest (#4783)", () => {
	/* A 4-file head held from minute 0 to its bound with no run alive, and a
	 * 1-file part waiting from minute 10, past PART_PASS_AGE_MS, that fits:
	 * MemAvailable between the two rungs. */
	const held = (shift: number, alongside: Run[] = []) => {
		const later = (t: number) => t + shift;
		const used = 10_000 - (suiteRungMb(1) + suiteRungMb(4)) / 2;
		const r = replay(
			{
				exits: [
					{ from: 0, to: 30, slotFree: true, reason: "timeout" },
					{ from: 10, to: 12, slotFree: true, reason: "opened" },
				].map((waiter, i) => {
					const e = exit(waiter, i);
					return { ...e, at: iso(later(Date.parse(e.at))) };
				}),
				runs: [
					{ from: 30, to: 35, session: "s-0", resolvedFiles: 4 },
					{ from: 12, to: 13, session: "s-1", resolvedFiles: 1 },
					...alongside,
				].map((spec) => {
					const x = run(spec);
					return { ...x, st: later(x.st), en: later(x.en) };
				}),
				mem: new Map(
					Array.from({ length: 60 }, (_, m) => [
						Math.floor(later(T0) / MIN) + m,
						{ used, load: 1, tsc: 0 },
					]),
				),
				windows: new Map(),
				unread: { absent: [], unparsed: 0 },
			},
			{ ...window(), since: later(T0), until: later(T0 + 60 * MIN) },
		);
		return Object.fromEntries(
			r.sessions.find((x) => x.session === "s-1")?.limbs ?? [],
		);
	};

	/* Any tick after #4783's commit. */
	it("lets the part that fits pass, from #4783's commit", () => {
		expect(held(Date.parse("2026-11-10T00:00:00Z") - T0)).toEqual({
			open: 120,
		});
	});

	/* One worker running: the part still fits its rung, but that run's end
	 * could let the head in, so the head is not at rest. */
	it("holds the part behind a head a running run's end could let in", () => {
		expect(
			held(Date.parse("2026-11-10T00:00:00Z") - T0, [
				{ from: 0, to: 40, session: "s-9", resolvedFiles: 1 },
			]),
		).toEqual({ "fifo-part": 120 });
	});

	it("held it behind the head before", () => {
		expect(held(0)).toEqual({ "fifo-part": 120 });
	});
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
				"  5678 1600000 node /repo/node_modules/.bin/tsc --noEmit",
				"  9012 1200 node scripts/queue-run.js --tsc -- /repo/node_modules/.bin/tsc",
				"  5678 R  12.8 1600000 node /repo/node_modules/.bin/tsc --noEmit",
				`=== ${local(T0)} 9000MB used ===`,
			].join("\n"),
		);
		const logs = readLogs({
			markers: dir,
			memwatch: [memwatch, path.join(dir, "absent.log")],
			minuteLog: path.join(dir, "memwatch-minute.jsonl"),
			since: T0,
			until: T0 + 60 * MIN,
		});
		expect(logs.exits).toHaveLength(1);
		expect(logs.runs).toHaveLength(1);
		expect([...logs.mem]).toEqual([
			[Math.floor(T0 / MIN) + 30, { used: 9500, load: 3.1, tsc: 1 }],
		]);
		expect(logs.unread.unparsed).toBe(1);
		expect(logs.unread.absent).toContain(path.join(dir, "absent.log"));

		const w = window();
		const out = render(replay(logs, w), w);
		expect(out).toContain("| count | 0.17 |");
		expect(out).toContain("| lander push gate | 0.17 |");
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
			minuteLog: path.join(dir, "memwatch-minute.jsonl"),
			since: st,
			until: st + 10 * MIN,
		});
		expect(logs.runs[0]).toMatchObject({ modulesRun: 4, modulesTotal: 600 });
	});
});
