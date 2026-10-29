/*
 * concurrency.test.ts — lib/concurrency.js's tick record and readout (#3317).
 * A break here names the wrong limit when the founder asks why only N
 * sessions run.
 */

import { describe, expect, it } from "vitest";

const { FULL, NOTHING_LAUNCHABLE } = require("./refill-decide.js");
const {
	buildBlockText,
	readout,
	buildTickRecord,
} = require("./concurrency.js");

const T0 = Date.parse("2026-10-28T00:00:00Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/* The module's own staleness bound, which a tick past reads as loop off. */
const STALE_MS = 15 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
/* A live reader a fresh tick must never call. */
const unread = () => {
	throw new Error("read admission over a fresh tick");
};

const minute = (ms: number, sessions: number | null) => ({
	ts: iso(ms),
	sessions,
});
const tickAt = (ms: number, binding: string | null, also: string[] = []) => ({
	at: iso(ms),
	working: 4,
	ceiling: 6,
	binding: binding && { limit: binding, why: `${binding} why` },
	also: also.map((limit) => ({ limit, why: `${limit} why` })),
	memory: { largest: { name: "non-session processes", mb: 1400 } },
});

const seat = (week: number, session: number, fits = 9) => ({
	seat: "s",
	week,
	session,
	weekFull: week >= FULL,
	sessionFull: session >= FULL,
	sessionResets: null,
	fits,
});
const input = (over: Record<string, unknown> = {}) => ({
	now: T0,
	freeSlots: 0,
	lastPromptAt: null,
	seats: [seat(10, 10)],
	overflow: [],
	...over,
});
const idle = (why: string | null) => ({ launches: [], skipped: [], idle: why });
const admission = (over: Record<string, unknown> = {}) => ({
	slots: 0,
	memorySlots: 1,
	drawNeedMb: 2000,
	floorMb: 794,
	marginMb: 300,
	landerMb: 0,
	load: { overloaded: false, load1: 3, ceiling: 48 },
	cpu: { full: false, slots: 2, sessions: 6, ceiling: 12 },
	memory: {
		working: { count: 6, mb: 3600 },
		other: { mb: 1400 },
		pool: { mb: 300 },
		finished: { mb: 0 },
	},
	...over,
});

describe("readout's time weighting (#3317)", () => {
	it.each([
		{
			name: "weights each minute line until the next, over uneven gaps",
			minutes: [
				minute(T0, 2),
				minute(T0 + 1 * MIN, 6),
				minute(T0 + 4 * MIN, 0),
			],
			now: T0 + 5 * MIN,
			// 2 for 1 min, 6 for 3 min: (2 + 18) / 4.
			sustained: 5,
			activeHours: 4 / 60,
		},
		{
			name: "excludes the minutes no session works from the sustained figure",
			minutes: [
				minute(T0, 0),
				minute(T0 + 10 * MIN, 3),
				minute(T0 + 12 * MIN, 0),
			],
			now: T0 + 20 * MIN,
			sustained: 3,
			activeHours: 2 / 60,
		},
		{
			name: "ends a line 15 minutes on where the recorder fell silent",
			minutes: [minute(T0, 4), minute(T0 + 2 * HOUR, 2)],
			now: T0 + 2 * HOUR + 15 * MIN,
			// 4 for 15 min, 2 for 15 min.
			sustained: 3,
			activeHours: 0.5,
		},
		{
			name: "skips a line whose count is unread",
			minutes: [minute(T0, null), minute(T0 + 1 * MIN, 2)],
			now: T0 + 2 * MIN,
			sustained: 2,
			activeHours: 1 / 60,
		},
		{
			name: "reads no figure off no working minute",
			minutes: [minute(T0, 0)],
			now: T0 + 5 * MIN,
			sustained: null,
			activeHours: 0,
		},
	])("$name", ({ minutes, now, sustained, activeHours }) => {
		const r = readout({ ticks: [], minutes, now, windowMs: 24 * HOUR });
		if (sustained === null) expect(r.sustained).toBeNull();
		else expect(r.sustained).toBeCloseTo(sustained, 9);
		expect(r.activeHours).toBeCloseTo(activeHours, 9);
	});

	it("counts only the window's share of a line that straddles its start", () => {
		const r = readout({
			ticks: [],
			minutes: [minute(T0, 2), minute(T0 + 10 * MIN, 0)],
			now: T0 + 10 * MIN,
			windowMs: 4 * MIN,
		});
		expect(r.activeHours).toBeCloseTo(4 / 60, 9);
	});

	it("charges each working minute to the tick verdict standing then, stale ones to the loop", () => {
		const r = readout({
			ticks: [tickAt(T0, "memory"), tickAt(T0 + 2 * MIN, null)],
			minutes: [
				minute(T0, 3),
				minute(T0 + 2 * MIN, 3),
				minute(T0 + 3 * MIN, 3),
				minute(T0 + 20 * MIN, 3),
				minute(T0 + 21 * MIN, 0),
			],
			now: T0 + 22 * MIN,
			windowMs: 24 * HOUR,
		});
		expect(r.hours.memory).toBeCloseTo(2 / 60, 9);
		expect(r.hours.none).toBeCloseTo(1 / 60 + 15 / 60, 9);
		expect(r.hours["loop not running"]).toBeCloseTo(1 / 60, 9);
		expect(r.spread).toEqual({ "3": 1 });
	});

	it("buckets the spread by session count, ten and over sharing one", () => {
		const r = readout({
			ticks: [],
			minutes: [
				minute(T0, 1),
				minute(T0 + 1 * MIN, 12),
				minute(T0 + 4 * MIN, 0),
			],
			now: T0 + 5 * MIN,
			windowMs: 24 * HOUR,
		});
		expect(r.spread).toEqual({ "1": 0.25, "10": 0.75 });
	});
});

describe("readout's verdict (#3317)", () => {
	it.each([
		{
			name: "reads the last tick's binding and also limits while it is fresh",
			ticks: [tickAt(T0, "founder slot", ["memory", "CPU"])],
			now: T0 + STALE_MS,
			verdict: "founder slot",
			also: ["memory", "CPU"],
		},
		{
			name: "reads loop not running once the last tick is over 15 minutes old",
			ticks: [tickAt(T0, "memory", ["CPU"])],
			now: T0 + STALE_MS + 1,
			verdict: "loop not running",
			also: [],
		},
		{
			name: "reads loop not running with no tick at all",
			ticks: [],
			now: T0,
			verdict: "loop not running",
			also: [],
		},
		{
			name: "reads none where the fresh tick found no limit failing",
			ticks: [tickAt(T0, null)],
			now: T0 + MIN,
			verdict: null,
			also: [],
		},
	])("$name", ({ ticks, now, verdict, also }) => {
		const r = readout({ ticks, minutes: [], now, windowMs: 24 * HOUR });
		expect(r.verdict?.limit ?? null).toBe(verdict);
		expect(r.also.map((f: { limit: string }) => f.limit)).toEqual(also);
	});

	it("prints the verdict, the also limits, memory's holder and the sustained figure", () => {
		const r = readout({
			ticks: [tickAt(T0, "allowance", ["memory"])],
			minutes: [minute(T0, 4), minute(T0 + 30 * MIN, 0)],
			now: T0 + 5 * MIN,
			windowMs: 24 * HOUR,
		});
		expect(buildBlockText(r, unread)).toBe(
			[
				`4 working at the last tick (${iso(T0)}), admission ceiling 6`,
				"bound by:  allowance — allowance why",
				"also:      memory (memory why)",
				"memory:    non-session processes holds most (1400 MB)",
				"sustained: 4.0 over the last 24 h (0.1 h with any session working)",
			].join("\n"),
		);
	});

	it("names a record that would not read above the verdict", () => {
		const r = readout({
			ticks: [],
			minutes: [],
			now: T0,
			windowMs: 24 * HOUR,
			unreadable: ["/x/concurrency.jsonl — EACCES"],
		});
		expect(buildBlockText(r, () => ({ count: 0, mb: 0 }))).toMatch(
			/^unreadable: \/x\/concurrency.jsonl — EACCES\nno refill-loop tick recorded$/m,
		);
	});

	it("prints the sustained figure unread where the minute record did not read (mantahostels#1206)", () => {
		const r = readout({
			ticks: [tickAt(T0, "allowance", [])],
			minutes: null,
			now: T0 + MIN,
			windowMs: 24 * HOUR,
		});
		expect(buildBlockText(r, unread)).toMatch(
			/^sustained: unread over the last 24 h — memwatch's minute record did not read$/m,
		);
	});

	it("prints a null sustained figure as the morning review does", () => {
		const r = readout({
			ticks: [tickAt(T0, "allowance", [])],
			minutes: [],
			now: T0 + MIN,
			windowMs: 24 * HOUR,
		});
		expect(buildBlockText(r, unread)).toMatch(
			/^sustained: no session recorded working over the last 24 h$/m,
		);
	});
});

describe("the unlisted watch (#3322, #3496, #3507)", () => {
	const row = (count: number | null, unknown: string | null = null) => ({
		count,
		mb: count && count * 450,
		unknown,
		dirs: [],
	});
	/** The block over one tick `age` old keeping `kept`, admission read now
	 * answering `live`. */
	const block = (age: number, kept: unknown, live: unknown = unread) =>
		buildBlockText(
			readout({
				ticks: [
					{
						...tickAt(T0, "memory"),
						memory: { ...tickAt(T0, "memory").memory, unlisted: kept },
					},
				],
				minutes: [],
				now: T0 + age,
				windowMs: 24 * HOUR,
			}),
			typeof live === "function" ? live : () => live,
		);

	it("reads a fresh tick's row, never admission now", () => {
		expect(block(MIN, row(2))).toContain(
			"unlisted:  2 session(s) outside admission's listing hold 900 MB at the last tick, charged no draw headroom (#2502)",
		);
	});

	it("reads admission now over a stale tick's row", () => {
		expect(block(STALE_MS + MIN, row(0), row(1))).toContain(
			"unlisted:  1 session(s) outside admission's listing hold 450 MB now, charged no draw headroom (#2502)",
		);
	});

	it("reads admission now where no tick is recorded", () => {
		const r = readout({ ticks: [], minutes: [], now: T0, windowMs: HOUR });
		expect(buildBlockText(r, () => row(1))).toContain(
			"unlisted:  1 session(s) outside admission's listing hold 450 MB now",
		);
	});

	it.each([
		{
			name: "admission now could not read",
			age: STALE_MS + MIN,
			kept: row(2),
			live: row(null, "session listing: refused"),
			line: "unlisted:  unknown now — session listing: refused",
		},
		{
			name: "a fresh tick kept an unread row",
			age: MIN,
			kept: row(null),
			live: unread,
			line: "unlisted:  unknown at the last tick — unread",
		},
	])("prints unknown where $name", ({ age, kept, live, line }) => {
		expect(block(age, kept, live)).toContain(line);
	});

	it("prints the reason a fresh tick's unlisted row went unread (#3507)", () => {
		const tick = buildTickRecord({
			input: input(),
			decision: idle("no free slot"),
			admission: admission({
				memory: {
					...admission().memory,
					unlisted: {
						count: null,
						mb: null,
						unknown: "no ids listed",
						dirs: [],
					},
				},
			}),
		});
		const r = readout({
			ticks: [tick],
			minutes: [],
			now: T0 + MIN,
			windowMs: HOUR,
		});
		expect(buildBlockText(r, unread)).toContain(
			"unlisted:  unknown at the last tick — no ids listed",
		);
	});

	const counted = { count: 2, mb: null, unknown: "pss: EACCES", dirs: [] };
	const heldLine = (when: string, why: string) =>
		`unlisted:  2 session(s) outside admission's listing hold ? MB ${when} (${why}), charged no draw headroom (#2502)`;

	it("names a counted row's unread memory on a fresh tick (#3509)", () => {
		const tick = buildTickRecord({
			input: input(),
			decision: idle("no free slot"),
			admission: admission({
				memory: { ...admission().memory, unlisted: counted },
			}),
		});
		const r = readout({
			ticks: [tick],
			minutes: [],
			now: T0 + MIN,
			windowMs: HOUR,
		});
		expect(buildBlockText(r, unread)).toContain(
			heldLine("at the last tick", "pss: EACCES"),
		);
	});

	it.each([
		{ name: "names", live: counted, why: "pss: EACCES" },
		{
			name: "marks unread",
			live: { ...counted, unknown: null },
			why: "unread",
		},
	])(
		"$name a counted row's unread memory on admission now (#3509)",
		({ live, why }) => {
			expect(block(STALE_MS + MIN, row(0), live)).toContain(
				heldLine("now", why),
			);
		},
	);

	it.each<[string, number, unknown, unknown]>([
		["reads none", MIN, row(0), unread],
		["carries no row", MIN, null, unread],
		["is stale and admission now reads none", STALE_MS + MIN, row(2), row(0)],
	])("prints no line where the newest tick %s", (_, age, kept, live) => {
		expect(block(age, kept, live)).not.toContain("unlisted:");
	});
});

describe("a tick's failing limits, in their fixed order (#3317)", () => {
	const Present = { lastPromptAt: T0 - MIN };
	it.each([
		{
			name: "orders every failing gate from the frontier to CPU",
			tick: {
				input: input({ freeSlots: 1, ...Present }),
				decision: idle(NOTHING_LAUNCHABLE),
				admission: admission({
					memorySlots: 0,
					cpu: { full: true, slots: 0, sessions: 12, ceiling: 12 },
				}),
			},
			limits: ["empty frontier", "founder slot", "memory", "CPU"],
		},
		{
			name: "puts the allowance after the frontier where a slot is free",
			tick: {
				input: input({ freeSlots: 2, seats: [seat(10, FULL)] }),
				decision: idle(NOTHING_LAUNCHABLE),
				admission: admission({ memorySlots: 0 }),
			},
			limits: ["empty frontier", "allowance", "memory"],
		},
		{
			name: "reads a stop request as the loop not running, resources after it",
			tick: {
				input: input(),
				decision: { stop: "explicit", detail: "stop was requested" },
				admission: admission({ memorySlots: 0 }),
			},
			limits: ["loop not running", "memory"],
		},
		{
			name: "reads the allowance cut as allowance",
			tick: {
				input: input(),
				decision: { stop: "allowance", detail: "every seat reads 100%" },
				admission: admission(),
			},
			limits: ["allowance"],
		},
		{
			name: "binds on the founder's slot where it is the only free one",
			tick: {
				input: input({ freeSlots: 1, ...Present }),
				decision: idle("one free slot is kept for the founder"),
				admission: admission({ slots: 1 }),
			},
			limits: ["founder slot"],
		},
		{
			name: "judges no allowance where no slot is free",
			tick: {
				input: input({ seats: [seat(10, FULL)] }),
				decision: idle("no free slot"),
				admission: admission({ memorySlots: 0 }),
			},
			limits: ["memory"],
		},
		{
			name: "reads an overloaded machine as CPU",
			tick: {
				input: input(),
				decision: idle("no free slot"),
				admission: admission({
					load: { overloaded: true, load1: 60, ceiling: 48 },
				}),
			},
			limits: ["CPU"],
		},
		{
			name: "finds nothing failing on a tick that launched, the founder present",
			tick: {
				input: input({ freeSlots: 2, lastPromptAt: T0 - MIN }),
				decision: { launches: [{}], skipped: [], idle: null },
				admission: admission({ slots: 2 }),
			},
			limits: [],
		},
		{
			name: "reads an unread admission as memory admitting no slot",
			tick: {
				input: input(),
				decision: idle("no free slot"),
				admission: null,
			},
			limits: ["memory"],
		},
	])("$name", ({ tick, limits }) => {
		const r = buildTickRecord(tick);
		expect(
			[r.binding, ...r.also]
				.filter(Boolean)
				.map((f: { limit: string }) => f.limit),
		).toEqual(limits);
	});

	it("records the first as binding, the rest as also, and memory's largest holder", () => {
		const r = buildTickRecord({
			input: input(),
			decision: idle("no free slot"),
			admission: admission({
				memorySlots: 0,
				landerMb: 2200,
				cpu: { full: true, slots: 0, sessions: 12, ceiling: 12 },
			}),
		});
		expect(r).toMatchObject({
			at: iso(T0),
			working: 6,
			ceiling: 6,
			binding: {
				limit: "memory",
				why: "the lander's suite reserve holds most (2200 MB)",
			},
			also: [{ limit: "CPU", why: "12 sessions fill the ceiling of 12" }],
			memory: { rows: { working: 3600, other: 1400, pool: 300, finished: 0 } },
		});
	});

	it("carries the breakdown's unlisted row (#3322)", () => {
		const unlisted = {
			count: 1,
			mb: 420,
			dirs: [{ dir: "~/.claude-b", count: 1 }],
		};
		const r = buildTickRecord({
			input: input(),
			decision: idle("no free slot"),
			admission: admission({
				memory: {
					...admission().memory,
					unlisted: { ...unlisted, unknown: null },
				},
			}),
		});
		expect(r.memory?.unlisted).toEqual({ ...unlisted, unknown: null });
	});

	const noFit = {
		limit: "memory",
		why: "admission's verdict carried no slot count or breakdown, so its fit is unknown",
	};
	it.each([
		{
			name: "no slots",
			over: { slots: undefined },
			working: 6,
			ceiling: null,
			failing: [noFit],
		},
		{
			name: "no memory slots",
			over: { memorySlots: undefined },
			working: 6,
			ceiling: 7,
			failing: [noFit],
		},
		{
			name: "no memory breakdown",
			over: { memory: undefined },
			working: null,
			ceiling: null,
			failing: [noFit],
		},
		{
			name: "no load or CPU reading",
			over: { load: undefined, cpu: undefined },
			working: 6,
			ceiling: 7,
			failing: [
				{
					limit: "CPU",
					why: "admission's verdict carried no load or CPU reading, so it is unknown",
				},
			],
		},
	])(
		"reads a verdict with $name as unknown, never NaN or a throw (#3531)",
		({ over, working, ceiling, failing }) => {
			const r = buildTickRecord({
				input: input(),
				decision: idle("no free slot"),
				admission: admission({ slots: 1, ...over }),
			});
			expect(r.working).toBe(working);
			expect(r.ceiling).toBe(ceiling);
			expect([r.binding, ...r.also].filter(Boolean)).toEqual(failing);
		},
	);

	it("records null counts and memory where admission did not read", () => {
		const r = buildTickRecord({
			input: input(),
			decision: idle("no free slot"),
			admission: null,
		});
		expect(r).toMatchObject({
			working: null,
			ceiling: null,
			binding: {
				limit: "memory",
				why: "admission.js did not read, so no slot is admitted",
			},
			also: [],
			memory: null,
		});
	});
});
