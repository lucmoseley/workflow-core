// @vitest-environment node
/*
 * A seat's reading, its cap sizing and the overflow seats' readings
 * (lib/seat-reading.js, #4218): the reading off a seat's bars, which stale
 * seats a tick refreshes and which it sizes, the cap call's flags and count,
 * the seats due a read for the panel, and each overflow seat's reading with
 * its budget injected. No fixture touches disk but the usage caches the
 * reading cases write, the cap call run on them, and the reads of
 * dispatch-sessions.sh that pin the copies of its cap thresholds and cap-call
 * flags to the script's.
 *
 * Loosen one and failover leaves its order, a full seat reopens before its
 * reset, a stale seat behind a full one is waited on rather than read, the
 * loop's cap disagrees with the dispatcher's, or the loop spends credits while
 * plan allowance remains.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAllowance } from "./allowance";
import { decideTick, FULL, hasRoom } from "./refill-decide.js";
import { MIN, NOW, seat } from "./refill-loop-fixture";
import { runInProcess } from "./run-in-process";
import {
	capArgs,
	ceilingsOf,
	overflowReadings,
	parseCapFits,
	readSizedSeats,
	seatReadingOf,
	seatsDueRead,
	seatTriedAfter,
	sizeResumeSeats,
} from "./seat-reading.js";
import { buildUsageCache } from "./usage-probe-fake";

const planSeat = (name: string, weekFull: boolean) =>
	seat(name, weekFull ? FULL : 50, 10);

const overflowSeat = (dir: string) => ({
	dir,
	kind: "overflow" as const,
	keyVar: `KEY_${path.basename(dir)}`,
	grantUsd: 200,
	cycleDay: 20,
});

const budget = (over: Record<string, unknown> = {}) => ({
	fit: 5,
	headroomUsd: 20,
	settledUsd: 100,
	reservedUsd: 80,
	creditUsd: 200,
	grantUsd: 200,
	readAt: null,
	qUsd: 4,
	running: 2,
	cycleStart: new Date(2026, 9, 20).getTime(),
	nextCycleStart: new Date(2026, 10, 20).getTime(),
	exhausted: false,
	...over,
});

describe("a seat's weekly reset, from its usage cache (#3732)", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "seat-reset-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
	const readAt = (fetchedAtMs: number, week: string, now = Date.now()) => {
		fs.writeFileSync(
			path.join(dir, ".claude.json"),
			JSON.stringify(
				buildUsageCache({ session: 10, week: 40 }, fetchedAtMs, {
					resetsAt: { week },
				}),
			),
		);
		return seatReadingOf(dir, readAllowance({ configDir: dir, now }), now);
	};

	it("carries the weekly bar's reset, fresh or aged", () => {
		const now = Date.now();
		const week = new Date(now + 3 * 24 * 60 * MIN).toISOString();
		expect(readAt(now, week).weekResets).toBe(Date.parse(week));
		expect(readAt(now - 60 * MIN, week)).toMatchObject({
			week: null,
			weekResets: Date.parse(week),
		});
	});

	it("keeps the weekly percent and its time, however aged (#3767)", () => {
		const now = Date.now();
		const week = new Date(now + 3 * 24 * 60 * MIN).toISOString();
		const aged = now - 60 * MIN;
		expect(readAt(aged, week).weekRead).toEqual({
			percent: 40,
			atMs: aged,
			rolled: false,
		});
	});

	it("reads a week reset since its read as 0, rolled, and leaves the picker unread (#4106)", () => {
		const now = Date.now();
		const aged = now - 6 * 24 * 60 * MIN;
		const week = new Date(now - 2 * 24 * 60 * MIN).toISOString();
		expect(readAt(aged, week)).toMatchObject({
			week: null,
			weekFull: false,
			weekRead: { percent: 0, atMs: aged, rolled: true },
		});
	});

	it("keeps a printed figure whose reset is a date Date.parse misreads (#4106)", () => {
		const now = Date.now();
		const usageText = "Current week (all models): 40% used · resets Nov 8\n";
		const bars = readAllowance({ configDir: dir, usageText, now });
		expect(seatReadingOf(dir, bars, now).weekRead).toEqual({
			percent: 40,
			atMs: now,
			rolled: false,
		});
	});

	it("reads an unreported session bar as 0, so the seat has room (#3758)", () => {
		const now = Date.now();
		fs.writeFileSync(
			path.join(dir, ".claude.json"),
			JSON.stringify(buildUsageCache({ week: 0 }, now)),
		);
		const r = seatReadingOf(dir, readAllowance({ configDir: dir, now }), now);
		expect(r).toMatchObject({ week: 0, session: 0, sessionFull: false });
		expect(hasRoom(r)).toBe(true);
		const cap = runInProcess(
			path.resolve(__dirname, "..", "allowance.js"),
			capArgs(dir, 3, { week: 97, session: 90 }),
			{ stdin: "" },
		);
		expect(parseCapFits(cap.stdout)).toEqual({ fits: 3 });
	});

	it("reads a stale weekly-only seat as unread, with no room and no cap (#3758)", () => {
		const now = Date.now();
		fs.writeFileSync(
			path.join(dir, ".claude.json"),
			JSON.stringify(buildUsageCache({ week: 0 }, now - 10 * MIN)),
		);
		const r = seatReadingOf(dir, readAllowance({ configDir: dir, now }), now);
		expect(r).toMatchObject({ week: null, session: null });
		expect(hasRoom(r)).toBe(false);
		const cap = runInProcess(
			path.resolve(__dirname, "..", "allowance.js"),
			capArgs(dir, 3, { week: 97, session: 90 }),
			{ stdin: "" },
		);
		expect(parseCapFits(cap.stdout)).toMatchObject({
			fits: null,
			fault: false,
		});
	});

	it("reads unread where the reset has passed", () => {
		const now = Date.now();
		const week = new Date(now - MIN).toISOString();
		expect(readAt(now - 60 * MIN, week).weekResets).toBeNull();
	});
});

describe("a seat's reading (#2606)", () => {
	const bar = (
		percent: number | null,
		trust: "fresh" | "stale" | "absent",
		resetsAt: string | null,
	) => ({ percent, trust, resetsAt, severity: null, fetchedAtMs: null });
	const Ahead = "2026-10-20T00:00:00Z";
	const Passed = "2026-10-18T11:00:00Z";
	const readOn = (
		session: ReturnType<typeof bar>,
		week: ReturnType<typeof bar>,
	) => seatReadingOf("s", { session, weekly_all: week }, NOW);
	const read = (week: ReturnType<typeof bar>) =>
		readOn(bar(30, "stale", Ahead), week);

	it("is weekly-full on a fresh 100% week", () => {
		expect(read(bar(100, "fresh", Ahead))).toMatchObject({
			week: 100,
			weekFull: true,
		});
	});

	it("is weekly-full on a cached 100% week whose reset is ahead, the bar still unread", () => {
		expect(read(bar(100, "stale", Ahead))).toEqual({
			seat: "s",
			week: null,
			session: null,
			weekFull: true,
			sessionFull: false,
			sessionResets: Ahead,
			weekResets: Date.parse(Ahead),
			readAt: NOW,
			weekRead: { percent: 100, atMs: null, rolled: false },
		});
	});

	it("is unread, not weekly-full, on a cached 100% whose reset has passed or will not parse", () => {
		expect(read(bar(100, "stale", Passed)).weekFull).toBe(false);
		expect(read(bar(100, "stale", null)).weekFull).toBe(false);
		expect(read(bar(99, "stale", Ahead)).weekFull).toBe(false);
		expect(read(bar(null, "absent", null)).weekFull).toBe(false);
	});

	it("carries a full 5-hour bar's reset, fresh or cached with the reset ahead", () => {
		const week = bar(40, "fresh", Ahead);
		expect(readOn(bar(100, "fresh", "3pm"), week)).toMatchObject({
			session: 100,
			sessionFull: true,
			sessionResets: "3pm",
		});
		expect(readOn(bar(100, "stale", Ahead), week)).toMatchObject({
			session: null,
			sessionFull: true,
			sessionResets: Ahead,
		});
		expect(readOn(bar(100, "stale", Passed), week)).toMatchObject({
			session: null,
			sessionFull: false,
		});
	});

	describe("through decideTick", () => {
		const tickOn = (
			session: ReturnType<typeof bar>,
			week: ReturnType<typeof bar>,
		) =>
			decideTick({
				now: NOW,
				mode: "normal" as const,
				noProgressFrom: NOW - 60 * MIN,
				stopRequested: false,
				frontier: [],
				retroBundles: [],
				running: [],
				freeSlots: 2,
				seats: [{ ...readOn(session, week), fits: null }],
				history: [],
			});

		it("waits out a locked seat's cached 100% week whose reset is ahead", () => {
			expect(
				tickOn(bar(30, "stale", Ahead), bar(100, "stale", Ahead)),
			).toMatchObject({ planWait: { resets: Date.parse(Ahead) } });
		});

		it("waits, unread, on a cached 100% week whose reset has passed", () => {
			expect(
				tickOn(bar(30, "stale", Ahead), bar(100, "stale", Passed)),
			).toMatchObject({ idle: "no plan has room right now" });
		});

		it("names a locked seat's cached 5-hour wait and its reset", () => {
			expect(
				tickOn(bar(100, "stale", Ahead), bar(40, "stale", Ahead)),
			).toMatchObject({
				idle: `the 5-hour bar is full on s until its 5-hour reset ${Ahead}`,
			});
		});
	});
});

/**
 * readSizedSeats over readings no probe changes, with the seats each probe
 * was asked to refresh.
 */
function sizedRead(
	readings: ReturnType<typeof seat>[],
	slots: number,
	sizeOf: (s: string, members: number) => number | null,
) {
	const probed: string[][] = [];
	const { seats } = readSizedSeats(slots, {
		read: () => readings,
		probe: (stale: string[]) => {
			probed.push(stale);
			return { usage: new Map(stale.map((s) => [s, ""])), probes: [] };
		},
		sizeOf,
		typedSeat: null,
	});
	return { probed, seats };
}

describe("the seats due a read for the panel's figures (#4060)", () => {
	const hourMs = 3_600_000;
	const dayMs = 24 * hourMs;
	const unreported = {
		percent: null,
		severity: null,
		resetsAt: null,
		fetchedAtMs: null,
		trust: "unreported" as const,
	};
	/** A seat's bars off a cache read `ago` before NOW, its week resetting at `resets`. */
	const barsOf = (percent: number | null, ago: number, resets: number) => {
		/* lib/allowance.js's trustOf, whose five-minute window it keeps private. */
		const isFresh = percent !== null && ago < 5 * 60_000 && resets > NOW;
		return {
			session: unreported,
			weekly_all: {
				percent,
				severity: null,
				resetsAt: new Date(resets).toISOString(),
				fetchedAtMs: percent === null ? null : NOW - ago,
				trust: isFresh ? ("fresh" as const) : ("stale" as const),
			},
		};
	};
	const due = (
		bars: ReturnType<typeof barsOf>,
		{ tried, ran = false }: { tried?: number; ran?: boolean } = {},
	) =>
		seatsDueRead(["s"], {
			barsOf: () => bars,
			triedAt: tried === undefined ? {} : { s: tried },
			hasRunSince: () => ran,
			now: NOW,
		});

	it("reads a seat past its reset, behind a fresh seat with room", () => {
		expect(
			seatsDueRead(["ahead", "behind"], {
				barsOf: (s) =>
					s === "ahead"
						? barsOf(10, 60_000, NOW + dayMs)
						: barsOf(100, 6 * dayMs, NOW - dayMs),
				triedAt: {},
				hasRunSince: () => false,
				now: NOW,
			}),
		).toEqual(["behind"]);
	});

	it("gives a seat at 100% before its reset no probe, however old or busy", () => {
		expect(due(barsOf(100, 6 * dayMs, NOW + hourMs), { ran: true })).toEqual(
			[],
		);
	});

	it("reads a seat with nothing run on it once in 24 hours", () => {
		const reset = NOW + 3 * dayMs;
		expect(due(barsOf(40, dayMs - hourMs, reset))).toEqual([]);
		expect(due(barsOf(40, dayMs, reset))).toEqual(["s"]);
	});

	it("reads sooner where a session ran since the last read", () => {
		expect(due(barsOf(40, hourMs, NOW + dayMs), { ran: true })).toEqual(["s"]);
	});

	it("asks nothing of a fresh reading, which a probe would only find cached", () => {
		expect(due(barsOf(40, 60_000, NOW + dayMs), { ran: true })).toEqual([]);
	});

	it("retries a failed probe under the same limit", () => {
		const stale = barsOf(100, 6 * dayMs, NOW - 2 * hourMs);
		expect(due(stale)).toEqual(["s"]);
		expect(due(stale, { tried: NOW - hourMs })).toEqual([]);
		expect(due(stale, { tried: NOW - hourMs, ran: true })).toEqual(["s"]);
		expect(due(stale, { tried: NOW - dayMs })).toEqual(["s"]);
	});

	it("reads an unread seat, under the same limit", () => {
		const unread = barsOf(null, 0, NOW + dayMs);
		expect(due(unread)).toEqual(["s"]);
		expect(due(unread, { tried: NOW - hourMs })).toEqual([]);
	});

	it("stamps a probe that ran, failed or not, and never one that found the cache fresh", () => {
		expect(
			seatTriedAfter(
				{ old: 1, cachedSeat: 2 },
				[
					{ seat: "stopped", outcome: "stopped" },
					{ seat: "timed", outcome: "timed-out" },
					{ seat: "cachedSeat", outcome: "cached" },
				],
				NOW,
			),
		).toEqual({ old: 1, cachedSeat: 2, stopped: NOW, timed: NOW });
	});
});

describe("which seats are refreshed", () => {
	const probedOn = (readings: ReturnType<typeof seat>[]) =>
		sizedRead(readings, 2, () => 1).probed;

	it("refreshes a stale seat ahead of a fresh one, so failover keeps order", () => {
		expect(probedOn([seat("a", null, null), seat("b", 10, 10)])).toEqual([
			["a"],
		]);
	});

	it("reads a stale seat behind a full one rather than waiting on it", () => {
		expect(probedOn([seat("a", 100, 10), seat("b", null, 5)])).toEqual([["b"]]);
	});

	it("refreshes nothing past a seat past the cap's threshold but under 100% (#2278)", () => {
		expect(probedOn([seat("a", 98, 10), seat("b", null, null)])).toEqual([]);
	});

	it("passes a seat full on a cached bar unread (#2606)", () => {
		expect(
			probedOn([
				{ ...seat("a", null, null), weekFull: true },
				{ ...seat("b", null, null), sessionFull: true },
				seat("c", null, null),
			]),
		).toEqual([["c"]]);
	});
});

describe("which seats the cap is sized on (#2278)", () => {
	const sizer = (answers: Record<string, number | null>) => {
		const asked: string[] = [];
		const sizeOf = (s: string, members: number) => {
			asked.push(`${s}:${members}`);
			return answers[s] ?? null;
		};
		return { asked, sizeOf };
	};

	it("sizes seats with room in order up to the first that sizes", () => {
		const { asked, sizeOf } = sizer({ b: 1, c: 2 });
		const out = sizedRead(
			[seat("a", 100, 10), seat("b", 98, 10), seat("c", 10, 10)],
			3,
			sizeOf,
		).seats;
		expect(asked).toEqual(["b:3"]);
		expect(out.map((s: { fits: number | null }) => s.fits)).toEqual([
			null,
			1,
			null,
		]);
	});

	it("falls through a seat the cap sizes 0 to the next with room (#2432)", () => {
		const { asked, sizeOf } = sizer({ a: 0, b: 2 });
		const out = sizedRead(
			[seat("a", 98, 10), seat("b", 10, 10), seat("c", 10, 10)],
			2,
			sizeOf,
		).seats;
		expect(asked).toEqual(["a:2", "b:2"]);
		expect(out.map((s: { fits: number | null }) => s.fits)).toEqual([
			0,
			2,
			null,
		]);
	});

	it("moves past a seat whose cap cannot be sized", () => {
		const { asked, sizeOf } = sizer({ b: 2 });
		sizedRead([seat("a", 98, 10), seat("b", 10, 10)], 2, sizeOf);
		expect(asked).toEqual(["a:2", "b:2"]);
	});

	it("sizes nothing with no slot free", () => {
		const { asked, sizeOf } = sizer({ a: 1 });
		const out = sizedRead([seat("a", 98, 10)], 0, sizeOf).seats;
		expect(asked).toEqual([]);
		expect(out[0].fits).toBe(0);
	});
});

describe("a tick's seat read past a seat sized 0 (#2432)", () => {
	/* Seat a reads 98% of the week and sizes 0; seat b is stale until probed,
	 * reading 10% then (or still stale, where its probe fails) and sizing 2. */
	function io(probeReads = true) {
		const probed: string[][] = [];
		const asked: string[] = [];
		return {
			probed,
			asked,
			read: (usage: Map<string, string>) => [
				seat("a", 98, 10),
				probeReads && usage.has("b")
					? seat("b", 10, 10)
					: seat("b", null, null),
			],
			probe: (seats: string[]) => {
				probed.push(seats);
				return {
					usage: new Map(seats.map((s) => [s, ""])),
					probes: seats.map((s) => ({ seat: s, outcome: "refreshed" })),
				};
			},
			sizeOf: (s: string, members: number) => {
				asked.push(`${s}:${members}`);
				return s === "a" ? 0 : 2;
			},
			typedSeat: null,
		};
	}

	it("probes the stale seat behind it once and sizes each seat once", () => {
		const fake = io();
		const out = readSizedSeats(2, fake);
		expect(fake.probed).toEqual([["b"]]);
		expect(fake.asked).toEqual(["a:2", "b:2"]);
		expect(out.seats.map((s: { fits: number | null }) => s.fits)).toEqual([
			0, 2,
		]);
		expect(out.probes).toEqual([{ seat: "b", outcome: "refreshed" }]);
	});

	it("probes a seat whose probe fails no second time", () => {
		const fake = io(false);
		const out = readSizedSeats(2, fake);
		expect(fake.probed).toEqual([["b"]]);
		expect(out.seats[1]).toMatchObject({ week: null, fits: null });
	});

	it("probes and sizes nothing with no slot free", () => {
		const fake = io();
		readSizedSeats(0, fake);
		expect(fake.probed).toEqual([]);
		expect(fake.asked).toEqual([]);
	});
});

describe("a move's seat reading (#3734)", () => {
	it("probes and sizes every seat with room, past the first, the move passing its own seat over", () => {
		const probed: string[][] = [];
		const asked: string[] = [];
		const { seats } = readSizedSeats(1, {
			read: (usage: Map<string, string>) => [
				seat("own", 10, 10),
				usage.has("other") ? seat("other", 10, 10) : seat("other", null, null),
			],
			probe: (stale: string[]) => {
				probed.push(stale);
				return { usage: new Map(stale.map((s) => [s, ""])), probes: [] };
			},
			sizeOf: (s: string) => {
				asked.push(s);
				return 1;
			},
			typedSeat: "own",
			sizeAll: true,
		});
		expect(probed).toEqual([["other"]]);
		expect(asked.sort()).toEqual(["other", "own"]);
		expect(seats.map((s: { fits: number | null }) => s.fits)).toEqual([1, 1]);
	});
});

describe("a tick's seat read in launch order (#3740)", () => {
	it("probes and sizes the typed seat first, though it is last in the seat file and stale", () => {
		const probed: string[][] = [];
		const asked: string[] = [];
		const out = readSizedSeats(2, {
			read: (usage: Map<string, string>) => [
				seat("a", 10, 10),
				usage.has("b") ? seat("b", 10, 10) : seat("b", null, null),
			],
			probe: (seats: string[]) => {
				probed.push(seats);
				return { usage: new Map(seats.map((s) => [s, ""])), probes: [] };
			},
			sizeOf: (s: string) => {
				asked.push(s);
				return 2;
			},
			typedSeat: "b",
		});
		expect(probed).toEqual([["b"]]);
		expect(asked).toEqual(["b"]);
		expect(out.seats.map((s: { seat: string }) => s.seat)).toEqual(["b", "a"]);
	});
});

describe("the cap's launch count (#2278)", () => {
	it("passes the flags dispatch-sessions.sh's cap call passes", () => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const call = sh.match(/allowance\.js" --json \\\n\s*(--cap[\s\S]*?) 2>/);
		const flags = (args: string[]) => args.filter((a) => a.startsWith("--"));
		expect(call).not.toBeNull();
		expect(
			flags(capArgs("s", 2, { week: 97, session: 90 })).filter(
				(f) => f !== "--config-dir",
			),
		).toEqual(["--json", ...flags(String(call?.[1]).split(/[\s\\]+/))]);
	});

	it("reads cap.launch from allowance.js's payload", () => {
		expect(parseCapFits(JSON.stringify({ cap: { launch: 2 } }))).toEqual({
			fits: 2,
		});
	});

	it("reads a launch that is the floor's member alone as 0 (#2432)", () => {
		expect(
			parseCapFits(JSON.stringify({ cap: { launch: 1, floored: true } })),
		).toEqual({ fits: 0 });
	});

	it.each([
		["no JSON", "oops", "printed no JSON", true],
		[
			"no cap, the reading untrusted",
			"{}",
			"no trustworthy allowance reading",
			false,
		],
		[
			"a cap error",
			JSON.stringify({ cap: { launch: 0, error: "cost table unreadable" } }),
			"cost table unreadable",
			true,
		],
	])(
		"reads %s as unsized, naming why and whether a fault (#2937)",
		(_, stdout, why, fault) => {
			expect(parseCapFits(stdout)).toEqual({
				fits: null,
				why: expect.stringContaining(why),
				fault,
			});
		},
	);
});

describe("dispatch's cap thresholds", () => {
	it("defaults to the figures dispatch-sessions.sh defaults to", () => {
		const sh = fs.readFileSync(
			path.join(__dirname, "..", "dispatch-sessions.sh"),
			"utf8",
		);
		const week = sh.match(
			/WEEK_CEILING="\$\{WFC_DISPATCH_WEEK_CEILING:-(\d+)\}"/,
		);
		const session = sh.match(
			/SESSION_CEILING="\$\{WFC_DISPATCH_SESSION_CEILING:-(\d+)\}"/,
		);
		expect(ceilingsOf({})).toEqual({
			week: Number(week?.[1]),
			session: Number(session?.[1]),
		});
	});

	it("reads the variables dispatch-sessions.sh reads", () => {
		expect(
			ceilingsOf({
				WFC_DISPATCH_WEEK_CEILING: "80",
				WFC_DISPATCH_SESSION_CEILING: "70",
			}),
		).toEqual({ week: 80, session: 70 });
	});
});

describe("sizeResumeSeats (#3895)", () => {
	const reading = (name: string, fits: number | null, week = 10) => ({
		seat: name,
		week,
		session: 10,
		weekFull: week >= 100,
		sessionFull: false,
		sessionResets: null,
		weekResets: null,
		readAt: NOW,
		weekRead: { percent: null, atMs: null },
		fits,
	});
	const due = (name: string, keyVar?: string) => ({
		jobId: `on-${name}`,
		seat: name,
		...(keyVar ? { keyVar } : {}),
		root: "wfc",
		at: NOW,
		line: "held",
	});
	/** The seats sized, each cap's reading fits 1, with the seats it read. */
	const size = (
		seats: ReturnType<typeof reading>[],
		resumable: ReturnType<typeof due>[],
		slots = 2,
	) => {
		const read: string[] = [];
		const out = sizeResumeSeats(seats, resumable, slots, (name, members) => {
			read.push(`${name}/${members}`);
			return 1;
		});
		return { read, fits: out.map((s) => s.fits) };
	};

	it("sizes no plan seat for a resume due on an overflow seat on its dir (#4147)", () => {
		expect(
			size([reading("a", 3), reading("b", null)], [due("b", "K2")]),
		).toEqual({ read: [], fits: [3, null] });
	});

	it("sizes a seat behind the first that has a resume due", () => {
		expect(size([reading("a", 3), reading("b", null)], [due("b")])).toEqual({
			read: ["b/2"],
			fits: [3, 1],
		});
	});

	it("sizes the next seat where the resumes take every fit before it", () => {
		expect(
			size(
				[reading("a", 1), reading("b", null), reading("c", null)],
				[due("a")],
			),
		).toEqual({ read: ["b/2"], fits: [1, 1, null] });
	});

	it("sizes nothing behind a seat with a fit to spare", () => {
		expect(size([reading("a", 2), reading("b", null)], [due("a")])).toEqual({
			read: [],
			fits: [2, null],
		});
	});

	it("leaves a seat with no room unsized, due or not", () => {
		expect(size([reading("a", null, 100)], [due("a")])).toEqual({
			read: [],
			fits: [null],
		});
	});

	it("reads no cap with no resume due or no slot free", () => {
		expect(size([reading("a", null)], []).read).toEqual([]);
		expect(size([reading("a", null)], [due("a")], 0).read).toEqual([]);
	});
});

describe("each overflow seat's reading", () => {
	const list = (...overflow: ReturnType<typeof overflowSeat>[]) => ({
		seats: [{ dir: "/s/plan", kind: "plan" as const }, ...overflow],
		errors: [],
	});
	const both = list(overflowSeat("/s/x"), overflowSeat("/s/y"));
	const first = list(overflowSeat("/s/x"));

	it("reads no budget while a plan seat is not weekly-full", () => {
		const read: string[] = [];
		const out = overflowReadings(
			both,
			[planSeat("a", true), planSeat("b", false)],
			(s) => {
				read.push(s.dir);
				return budget();
			},
		);
		expect(read).toEqual([]);
		expect(out.map((o) => o.fits)).toEqual([null, null]);
	});

	it("gives each seat's fit and headroom once every plan seat is weekly-full", () => {
		const fits = [3, 0];
		const out = overflowReadings(both, [planSeat("a", true)], () =>
			budget({ fit: fits.shift() }),
		);
		const read = { headroomUsd: 20, spentUntil: null, why: null };
		expect(out).toEqual([
			{ seat: "/s/x", keyVar: "KEY_x", fits: 3, ...read },
			{ seat: "/s/y", keyVar: "KEY_y", fits: 0, ...read },
		]);
	});

	it("marks a key spent until its cycle ends where refused for credit or settled past one reservation", () => {
		const until = "2026-11-20";
		for (const b of [
			budget({ fit: 0, exhausted: true }),
			budget({ fit: 0, settledUsd: 197, reservedUsd: 0, headroomUsd: 3 }),
		])
			expect(
				overflowReadings(first, [planSeat("a", true)], () => b)[0],
			).toMatchObject({ fits: 0, spentUntil: until });
	});

	it("passes an unread budget's reason on", () => {
		expect(
			overflowReadings(first, [planSeat("a", true)], () => ({
				why: "the session cost table is unreadable",
			})),
		).toEqual([
			{
				seat: "/s/x",
				keyVar: "KEY_x",
				fits: null,
				spentUntil: null,
				why: "the session cost table is unreadable",
			},
		]);
	});

	it("reads a seat file that refuses as one unread seat, so the tick waits on it", () => {
		const out = overflowReadings(
			{ seats: [], errors: ["refill-seats:2: missing cycle-day="] },
			[planSeat("a", true)],
			() => budget(),
		);
		expect(out).toEqual([
			{
				seat: "the seat file",
				fits: null,
				spentUntil: null,
				why: "it refuses: refill-seats:2: missing cycle-day=",
			},
		]);
	});
});

describe("a spent key anchored to a Console reading", () => {
	it("waits on a newer reading, not on the cycle day", () => {
		const dir = "/h/.claude3";
		const [reading] = overflowReadings(
			{ seats: [overflowSeat(dir)], errors: [] },
			[{ weekFull: true } as never],
			() => budget({ readAt: 1, creditUsd: 2, settledUsd: 0 }) as never,
		);
		expect(reading.spentUntil).toBe("a newer Console reading");
	});
});
