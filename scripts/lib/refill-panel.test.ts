/*
 * The panel's view and press mapping (#3873, #3875, #3877, #3879, #3881, #3883, #3884, #3948, #3958, #4059). Built on the view so every loop state costs one literal rather than a terminal.
 * Broken, the panel reads a press as done, or a stopped loop as on.
 */

import { describe, expect, it, vi } from "vitest";
import { QUIET_BENCH_PAUSE } from "./refill-decide.js";

const {
	ESC,
	buildFrame,
	findHoverRow,
	buildRows,
	createPanel,
} = require("./refill-panel.js");
const { buildOverflowStatus, buildSeatsView } = require("./refill-commands.js");
const { overflowReadings } = require("./refill-loop.js");

const AT = new Date(2026, 10, 2, 14, 5).getTime();
const LATER = AT + 60_000;

const BURN_OFF = { on: false, disagreeing: [], error: null };
const BURN_ON = { on: true, disagreeing: [], error: null };
const READ_AT = new Date(AT - 3_600_000).toISOString();
const seatRead = (seat: string, week: number | null, weekFull = false) => ({
	seat,
	week,
	weekFull,
	weekRead: { percent: week, at: READ_AT },
});
const planSeats = (week: number | null, weekFull = false) => ({
	readings: [
		seatRead("~/.claude3", 47),
		seatRead("~/.claude2", week, weekFull),
	],
	next: { seat: "~/.claude3", reason: "last typed on" },
});
const FULL_READINGS = [
	seatRead("~/.claude3", 100, true),
	seatRead("~/.claude2", 100, true),
];
const FULL_SEATS = { readings: FULL_READINGS, next: null };
/* What the picker says with every plan full and a key that fits a launch. */
const ON_KEY_SEATS = {
	readings: FULL_READINGS,
	next: { seat: "~/.claude2-api", reason: "overflow" },
};
const RUNNING = {
	running: true,
	stopRequested: false,
	stop: null,
	crashed: false,
	paused: null,
	lastTick: {
		at: AT,
		summary: "idle: no free slot",
		idle: "no free slot",
		paused: false,
	},
	launchesToday: 3,
	concurrency: { working: 9, ceiling: 9, limit: null, sustained: "8.4" },
	mode: "normal",
	handedOffSinceAway: 0,
	repos: [],
	goal: null,
	seats: planSeats(80),
	overflow: [],
	burnMode: BURN_OFF,
};
const LAUNCHED = "3 launched today · 9 of 9 running · 24h 8.4";
const MACHINE_FULL = "Machine full";
const PAUSED_TICK = {
	at: LATER,
	summary: "idle: paused by founder",
	idle: "paused by founder",
	paused: true,
};
const PAUSED_BY_FOUNDER = {
	...RUNNING,
	paused: { by: "founder", at: AT },
	lastTick: PAUSED_TICK,
};
/* The pause is written, but the tick now running started before it. */
const PAUSED_MID_TICK = {
	...RUNNING,
	paused: { by: "founder", at: LATER },
};
const NEVER_STARTED = { ...RUNNING, running: false };
const STOPPED = {
	...NEVER_STARTED,
	stop: { reason: "explicit", at: AT, detail: "stop asked" },
};
const CRASHED = { ...NEVER_STARTED, crashed: true };
const issuesIn = (...roots: string[]) =>
	roots.map((root, i) => ({ root, number: 2518 + i }));
const STALLED = {
	...RUNNING,
	paused: {
		by: "no-progress",
		at: AT,
		issues: issuesIn("/h/wc", "/h/wc", "/h/wc"),
	},
};
const planWaitTick = (resets: number | null) => ({
	at: AT,
	summary: "idle",
	idle: "a plan resets at 2026-11-02T18:40:00.000Z",
	paused: false,
	planWait: { resets },
});
const key = (over: object = {}) => ({
	seat: "~/.claude2-api",
	spentUsd: 142,
	grantUsd: 400,
	creditReadAt: null,
	headroomUsd: 258.5,
	exhausted: false,
	noLaunchLeft: false,
	running: 0,
	...over,
});
const STOPPING = { ...RUNNING, stopRequested: true };

/* The block's top row, as a mouse report counts it. */
const SWITCH_ROW = 2;
/* Below the switch, a row, its two lines, the plan rows and two rows clear: the settings. */
const AWAY_ROW = 12;
const AWAY_INDEX = AWAY_ROW - SWITCH_ROW;
/* One sibling row below Away (#3596 story 78). */
const BURN_ROW = 14;
const BURN_INDEX = BURN_ROW - SWITCH_ROW;
/* A gap, the heading and two plans, with no status or no seat to draw them. */
const PLAN_ROWS = 4;
/* A gap, the heading, one key's row, a gap and the spending state, with a key declared. */
const CREDIT_ROWS = 5;
const noop = (): void => undefined;

interface Row {
	text: string;
	role: string;
	detail?: string;
	control?: { state: string; name?: string };
}
const view = (over: object) => ({
	status: null,
	readError: null,
	goalEdit: null,
	goalResolve: null,
	pointer: null,
	focusNote: null,
	...over,
	presses: {
		...panelOver(noop).view.presses,
		...(over as { presses?: object }).presses,
	},
});
const buildPressing = (control: string, pending: object) => ({
	presses: { [control]: { pending, note: null } },
});
const buildNoted = (control: string, note: object) => ({
	presses: { [control]: { pending: null, note } },
});
const buildNote = (reason: string, remedy?: string) => ({
	reason,
	remedy: remedy ?? null,
	box: null,
	at: LATER,
});
/* What `refill-loop.js set --json` prints on a refusal. */
const buildRefusedStdout = (reason: string, remedy?: string, box?: string) =>
	JSON.stringify({
		refused: { reason, remedy: remedy ?? null, box: box ?? null },
		warning: null,
		lines: [],
	});
const rowsOf = (over: object): Row[] => buildRows(view(over), LATER, WIDE);
const summary = (rows: Row[]) => rows.map((r) => [r.text, r.role]);
/* The rows of one section: to the blank row that ends it. */
const toGap = (rows: Row[]) => {
	const end = rows.findIndex((r) => r.text === "");
	return end === -1 ? rows : rows.slice(0, end);
};
const focusMoved = async () => ({ code: 0, stdout: "", stderr: "" });
/* Every row fits. */
const TALL = 200;
const WIDE = 200;
const panelOver = (
	run: unknown,
	runBurn: unknown = run,
	resolveTopic: unknown = noop,
	{
		returnFocus = focusMoved,
		height = TALL,
		columns = WIDE,
	}: { returnFocus?: unknown; height?: number; columns?: number } = {},
) =>
	createPanel({
		run,
		runBurn,
		now: () => AT,
		resolveTopic,
		returnFocus,
		height: () => height,
		columns: () => columns,
		onChange: noop,
	});

function runnerOf(answers: Record<string, () => object>) {
	const calls: string[][] = [];
	const run = async (argv: string[]) => {
		calls.push(argv);
		return { code: 0, stdout: "", stderr: "", ...answers[argv.join(" ")]() };
	};
	return { calls, run };
}
const showing = (status: object) => () => ({ stdout: JSON.stringify(status) });

function heldUntil() {
	let release: () => void = noop;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { held, release };
}

describe("the panel's rows", () => {
	it("names the limit that binds, and an unread count as ?", () => {
		const line1 = (concurrency: object) =>
			summary(rowsOf({ status: { ...RUNNING, concurrency } }))[2][0];
		expect(
			line1({ working: 9, ceiling: 9, limit: "memory", sustained: "8.4" }),
		).toBe(`${LAUNCHED} · Limited by memory`);
		expect(
			line1({ working: null, ceiling: null, limit: "memory", sustained: "?" }),
		).toBe("3 launched today · ? of ? running · 24h ? · Limited by memory");
	});

	it("shows a running loop", () => {
		const rows = rowsOf({ status: RUNNING });
		expect(summary(rows).slice(0, 8)).toEqual([
			["Refill loop  [on]", "name"],
			["", "secondary"],
			[LAUNCHED, "value"],
			[MACHINE_FULL, "secondary"],
			["", "secondary"],
			["Weekly plan usage", "secondary"],
			["  .claude3  47% used (61m ago)", "secondary"],
			["  .claude2  80% used (61m ago)", "secondary"],
		]);
		expect(rows[0].control?.state).toBe("on");
	});

	it("leaves the waiting row blank after a tick that launched", () => {
		const lastTick = {
			at: AT,
			summary: "launched 2",
			idle: null,
			paused: false,
		};
		expect(rowsOf({ status: { ...RUNNING, lastTick } })[3].text).toBe("");
	});

	it.each([
		["no free slot", "Machine full"],
		["no plan has room right now", "No plan room"],
		["the 5-hour bar is full on ~/.claude3", "5-hour limit full"],
		["nothing launchable", "No ticket ready"],
		["shortlist failed in wc: boom", "Ticket list failed"],
		["resumes take every free slot", "Resuming paused sessions first"],
		[
			"every seat is spent; a resume is due",
			"All plans used up; a resume is due",
		],
		[
			"every seat is spent; a limit-held session waits on one",
			"All plans used up; a session waits",
		],
		[
			"no plan has room right now; no overflow launch: ~/.claude2 not weekly-full",
			"No plan room",
		],
	])("says %s in the founder's words", (idle, words) => {
		const lastTick = { at: AT, summary: `idle: ${idle}`, idle, paused: false };
		expect(rowsOf({ status: { ...RUNNING, lastTick } })[3].text).toBe(words);
	});

	it("falls back to an unmapped reason's first clause", () => {
		const idle = "a reason unmapped; and more";
		const lastTick = { at: AT, summary: `idle: ${idle}`, idle, paused: false };
		expect(rowsOf({ status: { ...RUNNING, lastTick } })[3].text).toBe(
			"a reason unmapped",
		);
	});

	it("gives the idle reason once in the block", () => {
		const rows = rowsOf({ status: RUNNING });
		expect(rows.filter((r) => r.text.includes(MACHINE_FULL))).toHaveLength(1);
		expect(rows.map((r) => r.text).join("\n")).not.toContain("idle:");
	});

	it("never shows a lifted pause's words beside a switch reading on", () => {
		const rows = rowsOf({ status: { ...RUNNING, lastTick: PAUSED_TICK } });
		expect(summary(rows).slice(0, 8)).toEqual([
			["Refill loop  [on]", "name"],
			["", "secondary"],
			[LAUNCHED, "value"],
			["", "secondary"],
			["", "secondary"],
			["Weekly plan usage", "secondary"],
			["  .claude3  47% used (61m ago)", "secondary"],
			["  .claude2  80% used (61m ago)", "secondary"],
		]);
	});

	it("shows a press to turn off, never reading as done", () => {
		const rows = rowsOf({
			status: RUNNING,
			...buildPressing("loop", { on: false, landed: false }),
		});
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  […]", "name"],
			["", "secondary"],
			["turning off…", "value"],
			["Turning off when this check ends", "secondary"],
		]);
		expect(rows[0].control?.state).toBe("pending");
	});

	it("shows a press to turn on", () => {
		const rows = rowsOf({
			status: PAUSED_BY_FOUNDER,
			...buildPressing("loop", { on: true, landed: false }),
		});
		expect(rows[2].text).toBe("turning on…");
		expect(rows[3].text).toBe("");
	});

	it("names the founder's switching off with its time", () => {
		const rows = rowsOf({ status: PAUSED_BY_FOUNDER });
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [off]", "name"],
			["", "secondary"],
			["You switched it off at 14:05", "value"],
			["Switch on to carry on", "secondary"],
		]);
		expect(rows[0].control?.state).toBe("off");
	});

	it("gives the date of a switching off on an earlier day", () => {
		const status = {
			...PAUSED_BY_FOUNDER,
			paused: { by: "founder", at: new Date(2026, 9, 30, 9, 7).getTime() },
		};
		expect(rowsOf({ status })[2].text).toBe(
			"You switched it off at 2026-10-30 09:07",
		);
	});

	it("says a click starts a paused loop with no process", () => {
		const status = { ...PAUSED_BY_FOUNDER, running: false };
		expect(rowsOf({ status })[3].text).toBe(
			"Not running: switch on to start it",
		);
	});

	it("reads one word, off, for a loop never started, and offers no restart", () => {
		const rows = rowsOf({ status: NEVER_STARTED });
		expect(rows[0].text).toBe("Refill loop  [off]");
		expect(rows[2].text).toBe("off");
		expect(rows[3].text).toBe("Not running: start it from the command line");
	});

	it("reads off with its time for a loop stopped from the command line", () => {
		const rows = rowsOf({ status: STOPPED });
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [off]", "name"],
			["", "secondary"],
			["off", "value"],
			[
				"Stopped from the command line at 14:05 · click to restart",
				"secondary",
			],
		]);
	});

	it("names the detail of a stop the command line did not ask for", () => {
		const stop = { reason: "control-damaged", at: AT, detail: "bad JSON" };
		expect(rowsOf({ status: { ...STOPPED, stop } })[3].text).toBe(
			"Stopped at 14:05: bad JSON · click to restart",
		);
	});

	it("reads needs you for a crash, with its restart", () => {
		const rows = rowsOf({ status: CRASHED });
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [off]", "name"],
			["", "secondary"],
			["needs you", "needsYou"],
			["It died with no stop · click to restart", "value"],
		]);
		expect(rows[0].control?.state).toBe("off");
	});

	it("reads needs you for a founder's pause whose process died", () => {
		const status = { ...PAUSED_BY_FOUNDER, running: false, crashed: true };
		expect(summary(rowsOf({ status })).slice(2, 4)).toEqual([
			["needs you", "needsYou"],
			["It died while switched off · click to restart", "value"],
		]);
	});

	it("reads needs you for no progress, with its issues", () => {
		const rows = rowsOf({ status: STALLED });
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [off]", "name"],
			["", "secondary"],
			["needs you", "needsYou"],
			["No progress: #2518, #2519, #2520", "value"],
		]);
		expect(rows[0].control?.state).toBe("off");
	});

	it("qualifies no progress's issues by repo where they span repos", () => {
		const paused = {
			...STALLED.paused,
			issues: issuesIn("/h/wc", "/h/manta"),
		};
		expect(rowsOf({ status: { ...STALLED, paused } })[3].text).toBe(
			"No progress: wc#2518, manta#2519",
		);
	});

	it("names the quiet bench's hold and why (#3852)", () => {
		const paused = { by: QUIET_BENCH_PAUSE, at: AT, why: "the bench is due" };
		const rows = summary(rowsOf({ status: { ...RUNNING, paused } }));
		expect(rows[2]).toEqual(["Held for a bench since 14:05", "value"]);
		expect(rows[3]).toEqual(["the bench is due", "secondary"]);
	});

	it("calls an unreadable pause neither the founder's nor no progress", () => {
		const paused = { by: "an unreadable record", at: AT };
		const rows = rowsOf({ status: { ...RUNNING, paused } });
		expect(summary(rows)[2]).toEqual([
			"Switched off at 14:05 by an unreadable record",
			"value",
		]);
	});

	it.each([
		["a founder's", PAUSED_BY_FOUNDER],
		["a no-progress", STALLED],
	])(
		"reads the stop, not %s pause, once stopped from the command line",
		(_name, pausedStatus) => {
			const status = { ...pausedStatus, running: false, stop: STOPPED.stop };
			expect(summary(rowsOf({ status })).slice(2, 4)).toEqual([
				["off", "value"],
				[
					"Stopped from the command line at 14:05 · click to restart",
					"secondary",
				],
			]);
		},
	);

	it("keeps the issues of a no-progress pause whose process died", () => {
		const status = { ...STALLED, running: false, crashed: true };
		expect(rowsOf({ status })[3].text).toContain("#2518");
	});

	it("keeps the switch on through an allowance wait, naming the earliest reset", () => {
		const resets = new Date(2026, 10, 2, 18, 40).getTime();
		const status = { ...RUNNING, lastTick: planWaitTick(resets) };
		const rows = rowsOf({ status });
		expect(rows[0].control?.state).toBe("on");
		expect(rows[3].text).toBe("Waiting: a plan resets at 18:40");
	});

	it("says an allowance wait's reset is unread rather than invent one", () => {
		const status = { ...RUNNING, lastTick: planWaitTick(null) };
		expect(rowsOf({ status })[3].text).toBe(
			"Waiting: a plan resets, its time unread",
		);
	});

	it("reads off, not on, once a stop is asked of a running loop", () => {
		const rows = rowsOf({ status: STOPPING });
		expect(rows[0].control?.state).toBe("off");
		expect(rows[2].text).toBe("off");
		expect(rows[3].text).toBe("Stopping: sessions running finish");
	});

	it("claims neither word while the status is unread", () => {
		expect(rowsOf({})[0].control?.state).toBe("unknown");
		const rows = rowsOf({ readError: "status --json: bad" });
		expect(rows[0].control?.state).toBe("unknown");
		expect(rows[2].text).toBe("Status unreadable");
		expect(rows[3].text).toBe("status --json: bad");
	});

	it("draws no plan rows where no status or seat says what to draw", () => {
		for (const c of [
			{},
			{ readError: "x" },
			{ status: { ...RUNNING, seats: { readings: [], next: null } } },
		])
			expect(rowsOf(c)[BURN_INDEX - PLAN_ROWS].text).toMatch(/^Burn mode/);
	});

	it("keeps every control where it is through every loop state, given the same seats and keys", () => {
		const withKey = (status: object) => ({
			...status,
			seats: FULL_SEATS,
			overflow: [key()],
		});
		const cases = [
			{ status: RUNNING },
			{ status: { ...RUNNING, lastTick: null } },
			{ status: CRASHED },
			{ status: STALLED },
			{ status: NEVER_STARTED },
			{ status: PAUSED_BY_FOUNDER },
			{ status: { ...PAUSED_BY_FOUNDER, running: false } },
			{ status: STOPPED },
			{ status: STOPPING },
			{
				status: RUNNING,
				...buildPressing("loop", { on: false, landed: true }),
			},
			{
				status: PAUSED_BY_FOUNDER,
				...buildPressing("loop", { on: true, landed: false }),
			},
			{ status: RUNNING, ...buildNoted("loop", buildNote("refused")) },
		];
		for (const c of cases)
			expect(rowsOf(c)[BURN_INDEX].text).toMatch(/^Burn mode/);
		for (const c of cases)
			expect(
				rowsOf({ ...c, status: withKey(c.status) })[BURN_INDEX + CREDIT_ROWS]
					.text,
			).toMatch(/^Burn mode/);
	});
});

describe("the plan and credit rows", () => {
	/* A tick that launched: the state the picker's key means launches are on credits. */
	const Launching = {
		...RUNNING,
		lastTick: { at: AT, summary: "launched 2", idle: null, paused: false },
	};
	/* The rows from the plan heading down to the settings, blank rows dropped. */
	const usage = (status: object) => {
		const rows = rowsOf({ status });
		const from = rows.findIndex((r: Row) => r.text === "Weekly plan usage");
		const to = rows.findIndex((r: Row) => r.text.startsWith("Away"));
		return summary(rows)
			.slice(from, to)
			.filter(([text]: string[]) => text !== "");
	};
	const PlansRoom = [
		["Weekly plan usage", "secondary"],
		["  .claude3  47% used (61m ago)", "secondary"],
		["  .claude2  80% used (61m ago)", "secondary"],
	];
	const PlansFull = [
		["Weekly plan usage", "secondary"],
		["  .claude3  100% used (61m ago)", "secondary"],
		["  .claude2  100% used (61m ago)", "secondary"],
	];
	/* Between the plans and credit heading above and the spend row below. */
	const keyRows = (status: object) =>
		usage(status).slice(PlansRoom.length + 1, -1);

	it("shows only the plans with no key declared, whatever they read", () => {
		expect(usage(RUNNING)).toEqual(PlansRoom);
		expect(usage({ ...RUNNING, seats: FULL_SEATS })).toEqual(PlansFull);
	});

	it("gives each key's estimate in grey and says it is not spending, with plans with room", () => {
		expect(usage({ ...RUNNING, overflow: [key()] })).toEqual([
			...PlansRoom,
			["API credits", "secondary"],
			["  .claude2  ~$258 of $400 left", "secondary"],
			["  Not spending: plans have room", "secondary"],
		]);
	});

	it("sets the spend row one blank row below the keys", () => {
		const texts = rowsOf({
			status: { ...RUNNING, overflow: [key()] },
		}).map((r: Row) => r.text);
		const at = texts.indexOf("  .claude2  ~$258 of $400 left");
		expect(texts.slice(at + 1, at + 3)).toEqual([
			"",
			"  Not spending: plans have room",
		]);
	});

	it("gives the keys in white and says it is spending, with launches on a key", () => {
		const overflow = [
			key(),
			key({ seat: "~/.claude3-api", headroomUsd: 100, grantUsd: 200 }),
		];
		expect(usage({ ...Launching, seats: ON_KEY_SEATS, overflow })).toEqual([
			...PlansFull,
			["API credits", "value"],
			["  .claude3  ~$100 of $200 left", "value"],
			["  .claude2  ~$258 of $400 left", "value"],
			["  Spending now: plans are full", "value"],
		]);
	});

	it("lists the keys in the plan rows' order, a key with no plan row last", () => {
		const overflow = [
			key({ seat: "~/.other-api" }),
			key({ seat: "~/.claude2-api" }),
			key({ seat: "~/.claude3-api" }),
		];
		const names = keyRows({ ...RUNNING, overflow }).map(
			([text]: string[]) => text.split("  ")[1],
		);
		expect(names).toEqual([".claude3", ".claude2", ".other"]);
	});

	it("reads a refused key as $0 with no ~, whatever the ledger leaves", () => {
		const overflow = [
			key({ seat: "~/.claude3-api", headroomUsd: 100.36, grantUsd: 200 }),
			key({
				exhausted: true,
				noLaunchLeft: true,
				headroomUsd: 26,
				grantUsd: 200,
			}),
		];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude3  ~$100 of $200 left", "secondary"],
			["  .claude2  $0 of $200 left", "secondary"],
		]);
	});

	it("draws a refused key in white with the rest, while spending", () => {
		const overflow = [
			key({ seat: "~/.claude3-api", running: 1 }),
			key({ exhausted: true, noLaunchLeft: true, grantUsd: 200 }),
		];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude3  ~$258 of $400 left", "value"],
			["  .claude2  $0 of $200 left", "value"],
		]);
	});

	it("drops the ~ and shows the reading's age while a Console reading is held", () => {
		const overflow = [
			key({
				headroomUsd: 170.02,
				grantUsd: 200,
				creditReadAt: LATER - 3 * 3600 * 1000,
			}),
		];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude2  $170 of $200 left (3h ago)", "secondary"],
		]);
	});

	it("shows a refused key's $0 with its reading's age", () => {
		const overflow = [
			key({
				exhausted: true,
				noLaunchLeft: true,
				creditReadAt: LATER - 2 * 86_400 * 1000,
			}),
		];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude2  $0 of $400 left (2d ago)", "secondary"],
		]);
	});

	it("keeps the ~ on a key the ledger alone calls spent", () => {
		const overflow = [key({ noLaunchLeft: true, headroomUsd: 3 })];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude2  ~$3 of $400 left", "secondary"],
		]);
	});

	it("says why on one row where the seat file refuses, naming no key", () => {
		const overflow = [{ seat: "the seat file", why: "it refuses: line 3" }];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  the seat file  unread: it refuses: line 3", "secondary"],
		]);
	});

	it("says all used up once every plan and key is spent, the switch staying on", () => {
		const status = {
			...RUNNING,
			seats: FULL_SEATS,
			overflow: [
				key({
					seat: "~/.claude3-api",
					exhausted: true,
					noLaunchLeft: true,
					grantUsd: 200,
				}),
				key({ noLaunchLeft: true, headroomUsd: 3 }),
			],
			lastTick: planWaitTick(AT),
		};
		expect(usage(status)).toEqual([
			...PlansFull,
			["Plans and API credits all used up", "value"],
			["  .claude3  $0 of $200 left", "secondary"],
			["  .claude2  ~$3 of $400 left", "secondary"],
			["  Not spending: no credits left", "secondary"],
		]);
		expect(rowsOf({ status })[0].control?.state).toBe("on");
	});

	it("keeps the heading while a plan has room, every key being spent", () => {
		const overflow = [key({ exhausted: true, noLaunchLeft: true })];
		expect(usage({ ...RUNNING, overflow }).slice(3)).toEqual([
			["API credits", "secondary"],
			["  .claude2  $0 of $400 left", "secondary"],
			["  Not spending: plans have room", "secondary"],
		]);
	});

	it("gives the unread key's reason on its row, never used up, with none live", () => {
		const overflow = [
			key({ noLaunchLeft: true, exhausted: true }),
			{ seat: "~/.claude3-api", why: "no table" },
		];
		expect(usage({ ...RUNNING, seats: FULL_SEATS, overflow })).toEqual([
			...PlansFull,
			["API credits", "secondary"],
			["  .claude3  unread: no table", "secondary"],
			["  .claude2  $0 of $400 left", "secondary"],
			["  Spending unknown", "secondary"],
		]);
	});

	it("leaves the other key's figure showing with one unread, in white while spending", () => {
		const overflow = [key(), { seat: "~/.claude3-api", why: "no table" }];
		expect(usage({ ...Launching, seats: ON_KEY_SEATS, overflow })).toEqual([
			...PlansFull,
			["API credits", "value"],
			["  .claude3  unread: no table", "secondary"],
			["  .claude2  ~$258 of $400 left", "value"],
			["  Spending now: plans are full", "value"],
		]);
	});

	it("shows a key reserved past its grant as nothing left, never less", () => {
		const overflow = [key({ headroomUsd: -11 })];
		expect(keyRows({ ...RUNNING, overflow })).toEqual([
			["  .claude2  ~$0 of $400 left", "secondary"],
		]);
	});

	it("says not spending on full plans where the loop launches nothing", () => {
		const seats = ON_KEY_SEATS;
		for (const status of [PAUSED_BY_FOUNDER, STOPPED, STOPPING])
			expect(usage({ ...status, seats, overflow: [key()] }).at(-1)).toEqual([
				"  Not spending: the loop is off",
				"secondary",
			]);
	});

	it("never says not spending over a key it cannot read, plans with room or not", () => {
		const overflow = [key(), { seat: "~/.claude3-api", why: "no table" }];
		expect(usage({ ...RUNNING, overflow }).slice(-3)).toEqual([
			["  .claude3  unread: no table", "secondary"],
			["  .claude2  ~$258 of $400 left", "secondary"],
			["  Spending unknown", "secondary"],
		]);
	});

	it("says not spending on a key the picker takes where the last tick idled", () => {
		const status = { ...RUNNING, seats: ON_KEY_SEATS, overflow: [key()] };
		expect(status.lastTick.idle).toBe("no free slot");
		expect(usage(status).slice(3)).toEqual([
			["API credits", "secondary"],
			["  .claude2  ~$258 of $400 left", "secondary"],
			["  Not spending: nothing launching", "secondary"],
		]);
	});

	it("gives a key with nothing yet spent as its whole grant, a plan with room", () => {
		const overflow = [
			buildOverflowStatus("~/.claude2-api", {
				fit: 10,
				headroomUsd: 200,
				settledUsd: 0,
				reservedUsd: 0,
				creditUsd: 200,
				grantUsd: 200,
				readAt: null,
				readFailure: null,
				lastAttemptAt: null,
				qUsd: 5,
				running: 0,
				cycleStart: AT,
				nextCycleStart: LATER,
				exhausted: false,
			}),
		];
		expect(usage({ ...RUNNING, overflow }).slice(3)).toEqual([
			["API credits", "secondary"],
			["  .claude2  ~$200 of $200 left", "secondary"],
			["  Not spending: plans have room", "secondary"],
		]);
	});

	it("says not spending while no plan can launch and one is not week-full", () => {
		const seats = { ...planSeats(80), next: null };
		expect(usage({ ...RUNNING, seats, overflow: [key()] }).at(-1)?.[0]).toBe(
			"  Not spending: waiting on a plan",
		);
	});

	it("says spending while a session runs on a key, the picker back on a plan", () => {
		expect(
			usage({ ...RUNNING, overflow: [key({ running: 2 })] }).slice(3),
		).toEqual([
			["API credits", "value"],
			["  .claude2  ~$258 of $400 left", "value"],
			["  Spending now: 2 on credits", "value"],
		]);
	});

	describe("a plan's figure (#4059)", () => {
		const buildReading = (
			week: number | null,
			percent: number | null,
			at: string | null,
		) => ({
			...seatRead("~/.claude2", week),
			weekRead: { percent, at },
		});
		const ago = (ms: number) => new Date(LATER - ms).toISOString();
		const shown = (reading: object) =>
			usage({
				...RUNNING,
				seats: { readings: [reading], next: null },
			})[1][0];

		it.each([
			["just read", buildReading(74, 74, ago(0)), "74% used (0m ago)"],
			[
				"minutes old",
				buildReading(null, 74, ago(300_000)),
				"74% used (5m ago)",
			],
			[
				"days old",
				buildReading(null, 100, ago(5 * 86_400_000)),
				"100% used (5d ago)",
			],
		])("gives a reading %s its figure and age", (_age, reading, figure) => {
			expect(shown(reading)).toBe(`  .claude2  ${figure}`);
		});

		it("says the age is unknown where the reading has no time", () => {
			expect(shown(buildReading(null, 74, null))).toBe(
				"  .claude2  74% used (age unknown)",
			);
		});

		it("reads a seat with no reading as unread", () => {
			expect(shown(buildReading(null, null, null))).toBe("  .claude2  unread");
		});

		it("shows the picker's 0 for a week the account does not report (#3758)", () => {
			expect(shown(buildReading(0, null, null))).toBe("  .claude2  0% used");
		});
	});

	it("draws no plan heading with no seat read", () => {
		const rows = rowsOf({
			status: { ...RUNNING, seats: { readings: [], next: null } },
		});
		expect(rows.map((r: Row) => r.text)).not.toContain("Weekly plan usage");
	});

	it("stays below the loop's lines through a pending press", () => {
		const rows = rowsOf({
			status: RUNNING,
			...buildPressing("loop", { on: false, landed: false }),
		});
		expect(rows[5].text).toBe("Weekly plan usage");
	});

	it("agrees with the picker's reading of the same status", () => {
		const reading = (week: number, weekFull: boolean) => ({
			seat: `${process.env.HOME}/.claude2`,
			week,
			session: 0,
			weekFull,
			sessionFull: false,
			sessionResets: null,
			weekResets: null,
			weekRead: { percent: week, atMs: AT },
			readAt: AT,
			fits: weekFull ? 0 : 1,
			fresh: true,
		});
		const dir = `${process.env.HOME}/.claude2-api`;
		const declared = {
			errors: [],
			seats: [
				{ dir, kind: "overflow", keyVar: "K", grantUsd: 200, cycleDay: 1 },
			],
		};
		const budget = (settledUsd: number, fit: number) => ({
			fit,
			headroomUsd: 200 - settledUsd,
			settledUsd,
			reservedUsd: 0,
			creditUsd: 200,
			grantUsd: 200,
			readAt: null,
			qUsd: 5,
			running: 0,
			cycleStart: AT,
			nextCycleStart: LATER,
			exhausted: false,
		});
		/* One budget through what a tick and what `status --json` each read. */
		const statusFor = (
			seat: ReturnType<typeof reading>,
			b: ReturnType<typeof budget>,
			tick: object = Launching,
		) => ({
			...tick,
			seats: buildSeatsView({
				seats: [seat],
				overflow: overflowReadings(declared, [seat], () => b),
				typedSeat: null,
				ceilings: { week: 100, session: 100 },
			}),
			overflow: [buildOverflowStatus(dir, b)],
		});
		const lastRow = (status: object) => usage(status).at(-1)?.[0];
		const full = reading(100, true);
		const onKey = statusFor(full, budget(150, 10));
		expect(onKey.seats.next?.seat).toBe(onKey.overflow[0].seat);
		expect(lastRow(onKey)).toBe("  Spending now: plans are full");
		const onPlan = statusFor(reading(40, false), budget(150, 10));
		expect(onPlan.seats.next?.seat).not.toBe(onPlan.overflow[0].seat);
		expect(lastRow(onPlan)).toBe("  Not spending: plans have room");
		const idled = statusFor(full, budget(150, 10), RUNNING);
		expect(idled.seats.next?.seat).toBe(idled.overflow[0].seat);
		expect(lastRow(idled)).toBe("  Not spending: nothing launching");
		const spent = statusFor(full, budget(198, 0));
		expect(spent.seats.next).toBeNull();
		expect(lastRow(spent)).toBe("  Not spending: no credits left");
	});
});

describe("yellow", () => {
	const yellow = "38;2;255;215;0m";
	const framed = (status: object) => buildFrame(rowsOf({ status }), 120, 40);

	it("draws only the words needs you", () => {
		for (const status of [CRASHED, STALLED]) {
			const after = framed(status).split(yellow);
			expect(after).toHaveLength(2);
			expect(after[1].startsWith("needs you")).toBe(true);
		}
	});

	it("appears in no other state", () => {
		for (const status of [
			RUNNING,
			STOPPED,
			NEVER_STARTED,
			STOPPING,
			PAUSED_BY_FOUNDER,
			{
				...RUNNING,
				seats: FULL_SEATS,
				overflow: [key({ noLaunchLeft: true })],
			},
			{ ...RUNNING, lastTick: planWaitTick(AT) },
		])
			expect(framed(status)).not.toContain(yellow);
	});
});

describe("the panel's colours", () => {
	const frame = buildFrame(rowsOf({ status: RUNNING }), 80, 40);

	it("draws names bold white, live values white, secondary text #949494", () => {
		expect(frame).toContain(`${ESC}[1m${ESC}[38;2;242;242;242mRefill loop`);
		expect(frame).toContain(`${ESC}[38;2;242;242;242m${LAUNCHED}`);
		expect(frame).toContain(`${ESC}[38;2;148;148;148m${MACHINE_FULL}`);
	});

	it("uses no blue in any colour it draws", () => {
		const all = frame + buildFrame(rowsOf({ status: CRASHED }), 80, 40);
		for (const [, r, g, b] of all.matchAll(/38;2;(\d+);(\d+);(\d+)m/g))
			expect(Number(b)).toBeLessThanOrEqual(Math.max(Number(r), Number(g)));
	});
});

describe("the panel's frame", () => {
	const tickOf = (idle: string) => ({
		...RUNNING,
		lastTick: { at: AT, summary: "", idle, paused: false },
	});

	it("wraps a long row whole at its word boundaries", () => {
		const status = tickOf("a reason far longer than one row of this pane");
		const frame = buildFrame(buildRows(view({ status }), LATER, 24), 24, 40);
		for (const line of ["a reason far longer", "than one row of this", "pane"])
			expect(frame).toContain(`${line}${ESC}`);
		expect(frame).not.toContain("…");
	});

	it("breaks a word longer than a row where the row ends", () => {
		const rows = buildRows(
			view({ status: tickOf(`a ${"x".repeat(30)}`) }),
			LATER,
			24,
		);
		expect(rows.map((r: Row) => r.text)).toEqual(
			expect.arrayContaining(["a", "x".repeat(20), "x".repeat(10)]),
		);
	});

	it("draws a row of nothing but spaces longer than a line", () => {
		const unread = { status: null, readError: " ".repeat(40) };
		expect(buildRows(view(unread), LATER, 24)[3].text.trim()).toBe("");
	});

	it("keeps a wrapped row's indent", () => {
		const rows = buildRows(view({ status: RUNNING }), LATER, 20);
		const at = rows.findIndex((r: Row) => r.text === "  .claude3  47%");
		expect(rows[at + 1].text).toBe("  used (61m ago)");
	});

	it("leaves a row holding an image on its one line, cut", () => {
		const repos = [
			{ name: "n".repeat(40), root: "/h/n", ticked: true, disabled: null },
		];
		const rows = buildRows(view({ status: { ...RUNNING, repos } }), LATER, 24);
		expect(rows.filter((r: Row) => r.text.includes("nnn"))).toHaveLength(1);
		expect(buildFrame(rows, 24, 80)).toContain("n…");
	});

	it("erases below its last row, so a report gone from the rows goes from the screen", () => {
		const frame = buildFrame(rowsOf({ status: RUNNING }), 80, 40);
		expect(frame.endsWith(`${ESC}[J`)).toBe(true);
	});

	it("draws no control character a command printed", () => {
		const refusal = buildNoted("loop", buildNote(`bad${ESC}[31m\nthing`));
		const frame = buildFrame(rowsOf({ status: RUNNING, ...refusal }), 80, 40);
		expect(frame).toContain("bad [31m thing");
	});
});

describe("the press record", () => {
	it.each([
		["loop", "set --pause --json", SWITCH_ROW],
		["away", "set --away --json", AWAY_ROW],
	])("holds the %s press's mark, then its note", async (control, argv, row) => {
		const { held, release } = heldUntil();
		const runSet = async (asked: string[]) => {
			if (asked.join(" ") !== argv)
				return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
			await held;
			return {
				code: 1,
				stdout: buildRefusedStdout("refused", "do this"),
				stderr: "",
			};
		};
		const panel = panelOver(runSet);
		await panel.refreshStatus();
		const done = panel.click(row);
		expect(panel.view.presses[control].pending).toMatchObject({
			landed: false,
		});
		release();
		await done;
		expect(panel.view.presses[control]).toMatchObject({
			pending: null,
			note: { reason: "refused", remedy: "do this", box: null },
		});
	});
});

describe("a click on the switch", () => {
	it("pauses a running loop through `set --pause`", async () => {
		const { calls, run } = runnerOf({
			"set --pause --json": () => ({}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls[1]).toEqual(["set", "--pause", "--json"]);
	});

	it("resumes a paused loop through `set --resume`", async () => {
		const { calls, run } = runnerOf({
			"set --resume --json": () => ({}),
			"status --json": showing(PAUSED_BY_FOUNDER),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls[1]).toEqual(["set", "--resume", "--json"]);
	});

	it.each([
		["crashed", CRASHED],
		["stopped", STOPPED],
		["paused, its process dead", { ...STALLED, running: false, crashed: true }],
	])("restarts a %s loop through `set --resume`", async (_name, status) => {
		const { calls, run } = runnerOf({
			"status --json": showing(status),
			"set --resume --json": () => ({}),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls).toContainEqual(["set", "--resume", "--json"]);
	});

	it.each([
		["crashed", CRASHED, 3],
		["stopped", STOPPED, 3],
		["never started", NEVER_STARTED, 1],
	])(
		"takes a click on a %s loop's words as on the switch",
		async (_name, status, callCount) => {
			const { calls, run } = runnerOf({
				"status --json": showing(status),
				"set --resume --json": () => ({}),
			});
			const panel = panelOver(run);
			await panel.refreshStatus();
			await panel.click(SWITCH_ROW + 3);
			expect(calls).toHaveLength(callCount);
		},
	);

	it("holds the word until a read shows the restarted process", async () => {
		let status: object = CRASHED;
		const { run } = runnerOf({
			"status --json": () => ({ stdout: JSON.stringify(status) }),
			"set --resume --json": () => ({}),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(panel.view.presses.loop.pending?.on).toBe(true);
		status = RUNNING;
		await panel.refreshStatus();
		expect(panel.view.presses.loop.pending).toBeNull();
	});

	it("gives the row back where the restarted process never shows", async () => {
		const { run } = runnerOf({
			"status --json": showing(CRASHED),
			"set --resume --json": () => ({}),
		});
		let at = AT;
		const panel = createPanel({
			run,
			runBurn: run,
			now: () => at,
			returnFocus: focusMoved,
			height: () => TALL,
			columns: () => WIDE,
			onChange: noop,
		});
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		at += 29_000;
		await panel.refreshStatus();
		expect(panel.view.presses.loop.pending?.on).toBe(true);
		at += 1000;
		await panel.refreshStatus();
		expect(panel.view.presses.loop.pending).toBeNull();
		expect(buildRows(panel.view, at, WIDE)[2].text).toBe("needs you");
	});

	it.each([
		["never started", NEVER_STARTED],
		["stopping", STOPPING],
	])("writes nothing for a press on a loop %s", async (_name, status) => {
		const { calls, run } = runnerOf({ "status --json": showing(status) });
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls).toEqual([["status", "--json"]]);
	});

	it("has no argv on any row that stops the process", async () => {
		const asked: string[][] = [];
		for (const status of [RUNNING, STALLED, CRASHED, STOPPED, STOPPING]) {
			const { calls, run } = runnerOf({
				"status --json": showing(status),
				"set --pause --json": () => ({}),
				"set --resume --json": () => ({}),
				"set --away --json": () => ({}),
				on: () => ({}),
				off: () => ({}),
			});
			const panel = panelOver(run);
			await panel.refreshStatus();
			const rows = buildRows(panel.view, AT, WIDE).length;
			for (let row = SWITCH_ROW; row < SWITCH_ROW + rows; row++)
				await panel.click(row);
			asked.push(...calls);
		}
		expect(asked.flat()).not.toContain("stop");
	});

	it("runs nothing before a read, or off the switch row", async () => {
		const { calls, run } = runnerOf({ "status --json": showing(RUNNING) });
		const panel = panelOver(run);
		await panel.click(SWITCH_ROW);
		expect(calls).toEqual([]);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW + 2);
		expect(calls).toHaveLength(1);
	});

	it("shows the word before the command returns, and takes a second click as nothing", async () => {
		const { held, release } = heldUntil();
		const sets: string[][] = [];
		const run = async (argv: string[]) => {
			if (argv[0] === "set") {
				sets.push(argv);
				await held;
			}
			return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
		};
		const panel = panelOver(run);
		await panel.refreshStatus();
		const clicked = panel.click(SWITCH_ROW);
		expect(buildRows(panel.view, LATER, WIDE)[2].text).toBe("turning off…");
		await panel.click(SWITCH_ROW);
		expect(sets).toHaveLength(1);
		release();
		await clicked;
	});
});

describe("the status reads", () => {
	it("never overlap: one asked for during another runs after it", async () => {
		const { held, release } = heldUntil();
		let live = 0;
		let most = 0;
		let reads = 0;
		const run = async () => {
			live += 1;
			reads += 1;
			most = Math.max(most, live);
			if (reads === 1) await held;
			live -= 1;
			return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
		};
		const panel = panelOver(run);
		const first = panel.refreshStatus();
		await panel.refreshStatus();
		expect(reads).toBe(1);
		release();
		await first;
		expect(reads).toBe(2);
		expect(most).toBe(1);
	});
});

describe("the pending word", () => {
	/** A panel whose press is made against `before`, reading `after` once it lands. */
	async function pressed(
		before: object,
		after: object,
		press = "set --pause --json",
	) {
		let status = before;
		const { run } = runnerOf({
			[press]: () => {
				status = after;
				return {};
			},
			"status --json": () => ({ stdout: JSON.stringify(status) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		return {
			panel,
			show: async (next: object) => {
				status = next;
				await panel.refreshStatus();
			},
		};
	}

	it("stays on a read showing the pause while the running tick finishes", async () => {
		const { panel } = await pressed(RUNNING, PAUSED_MID_TICK);
		expect(panel.view.presses.loop.pending).not.toBeNull();
		expect(buildRows(panel.view, LATER, WIDE)[3].text).toBe(
			"Turning off when this check ends",
		);
	});

	it("clears once a tick has started since the pause", async () => {
		const { panel, show } = await pressed(RUNNING, PAUSED_MID_TICK);
		await show({ ...PAUSED_MID_TICK, lastTick: PAUSED_TICK });
		expect(panel.view.presses.loop.pending).toBeNull();
		expect(buildRows(panel.view, LATER, WIDE)[2].text).toBe(
			"You switched it off at 14:06",
		);
	});

	it("clears at once where no process runs to take the pause", async () => {
		const { panel } = await pressed(RUNNING, {
			...PAUSED_MID_TICK,
			running: false,
		});
		expect(panel.view.presses.loop.pending).toBeNull();
	});

	it("clears on a read showing a resume", async () => {
		const { panel } = await pressed(
			PAUSED_BY_FOUNDER,
			{ ...RUNNING, lastTick: PAUSED_TICK },
			"set --resume --json",
		);
		expect(panel.view.presses.loop.pending).toBeNull();
		const rows = buildRows(panel.view, LATER, WIDE);
		expect(rows[0].control.state).toBe("on");
		expect(rows[3].text).toBe("");
	});

	it("does not clear on a read begun before the command returned, even one showing no process", async () => {
		const { held, release } = heldUntil();
		let status: object = RUNNING;
		const run = async (argv: string[]) => {
			if (argv[0] === "set") await held;
			return { code: 0, stdout: JSON.stringify(status), stderr: "" };
		};
		const panel = panelOver(run);
		await panel.refreshStatus();
		const clicked = panel.click(SWITCH_ROW);
		status = STOPPED;
		await panel.refreshStatus();
		expect(panel.view.presses.loop.pending).not.toBeNull();
		release();
		await clicked;
		expect(panel.view.presses.loop.pending).toBeNull();
	});

	it("clears where another writer has since reversed the press", async () => {
		const { panel } = await pressed(RUNNING, RUNNING);
		expect(panel.view.presses.loop.pending).toBeNull();
	});

	it("clears on the command's refusal and shows it, then gives line 2 back", async () => {
		const { run } = runnerOf({
			"set --pause --json": () => ({
				code: 1,
				stdout: buildRefusedStdout(
					"the control is damaged",
					"`start` rewrites it",
				),
			}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(panel.view.presses.loop.pending).toBeNull();
		const rows = buildRows(panel.view, AT + 1, WIDE);
		expect(rows[0].control.state).toBe("on");
		expect(rows[3].text).toBe("the control is damaged; `start` rewrites it");
		expect(buildRows(panel.view, LATER, WIDE)[3].text).toBe(MACHINE_FULL);
	});

	it("survives an unreadable status, and claims nothing during it", async () => {
		const { panel, show } = await pressed(RUNNING, PAUSED_MID_TICK);
		await show({ nonsense: true });
		expect(panel.view.presses.loop.pending).not.toBeNull();
		expect(panel.view.status).toBeNull();
	});
});

describe("the Burn mode switch", () => {
	const Plan = ".claude2/settings.json";
	const Stuck = {
		code: 1,
		stdout: `burn mode: on\n  ${Plan} claude-opus-5-5 effort=high\n`,
		stderr: `error: still on the burn effort after off:\n  ${Plan}\n`,
	};
	const running = (burnMode: object) => ({ ...RUNNING, burnMode });
	/* From Burn mode to the section gap, less the row under its title. */
	const burnSection = (rows: Row[]) => {
		const at = rows.findIndex((r) => r.text.startsWith("Burn mode"));
		const [title, gap, ...below] = rows.slice(at);
		return gap.text === "" && below[0]?.text !== ""
			? [title, ...toGap(below)]
			: [title];
	};
	const burnRowsOf = (over: object) => burnSection(rowsOf(over));
	const burnRows = (panel: { view: object }): Row[] =>
		burnSection(buildRows(panel.view, LATER, WIDE));
	const answerOk = { code: 0, stdout: "", stderr: "" };

	/** A panel reading `status`, whose flips answer `answers` in turn, the last repeating. */
	async function panelFlipping(status: object, ...answers: object[]) {
		const flips: string[][] = [];
		let current = status;
		const panel = panelOver(
			async () => ({ ...answerOk, stdout: JSON.stringify(current) }),
			async (argv: string[]) => {
				flips.push(argv);
				return { ...answerOk, ...answers[flips.length - 1] };
			},
		);
		await panel.refreshStatus();
		return {
			flips,
			panel,
			setStatus: (next: object) => {
				current = next;
			},
		};
	}

	it.each([
		[BURN_OFF, "[off]", "off"],
		[BURN_ON, "[on]", "on"],
	])("shows %j as %s", (burnMode, shown, state) => {
		const [row] = burnRowsOf({ status: running(burnMode) });
		expect(row.text).toBe(`Burn mode  ${shown}`);
		expect(row.control?.state).toBe(state);
	});

	it("claims neither word while the status is unread, or where the machine will not say", () => {
		expect(burnRowsOf({})[0].control?.state).toBe("unknown");
		const rows = burnRowsOf({
			status: running({ on: null, disagreeing: [], error: "HOME is unset" }),
		});
		expect(rows[0].control?.state).toBe("unknown");
		expect(rows[1].text).toBe("HOME is unset");
	});

	it("runs nothing where the machine will not say", async () => {
		const { flips, panel } = await panelFlipping(
			running({ on: null, disagreeing: [], error: "HOME is unset" }),
		);
		await panel.click(BURN_ROW);
		expect(flips).toEqual([]);
	});

	it("turns burn mode on through the script's `on`, and leaves the loop's command line alone", async () => {
		const { flips, panel } = await panelFlipping(RUNNING);
		await panel.click(BURN_ROW);
		expect(flips).toEqual([["on"]]);
		expect(panel.view.presses.loop.pending).toBeNull();
	});

	it("turns burn mode off through the script's `off`", async () => {
		const { flips, panel } = await panelFlipping(running(BURN_ON));
		await panel.click(BURN_ROW);
		expect(flips).toEqual([["off"]]);
	});

	it("runs nothing before a read", async () => {
		const flips: string[][] = [];
		const panel = panelOver(noop, async (argv: string[]) => {
			flips.push(argv);
			return answerOk;
		});
		await panel.click(BURN_ROW);
		expect(flips).toEqual([]);
	});

	it("reads pending until a read after the flip, and takes a second click as nothing", async () => {
		const { held, release } = heldUntil();
		const flips: string[][] = [];
		const panel = panelOver(
			async () => ({ ...answerOk, stdout: JSON.stringify(RUNNING) }),
			async (argv: string[]) => {
				flips.push(argv);
				await held;
				return answerOk;
			},
		);
		await panel.refreshStatus();
		const clicked = panel.click(BURN_ROW);
		const [row] = burnRows(panel);
		expect(row.text).toBe("Burn mode  […]  turning on…");
		expect(row.control?.state).toBe("pending");
		await panel.refreshStatus();
		expect(panel.view.presses.burn.pending).not.toBeNull();
		await panel.click(BURN_ROW);
		expect(flips).toHaveLength(1);
		release();
		await clicked;
		expect(panel.view.presses.burn.pending).toBeNull();
	});

	it("shows the observed state and the skill's restart line after a clean flip", async () => {
		const { panel, setStatus } = await panelFlipping(RUNNING, {
			stdout: "burn mode: on\n",
		});
		setStatus(running(BURN_ON));
		await panel.click(BURN_ROW);
		expect(summary(burnRows(panel))).toEqual([
			["Burn mode  [on]", "name"],
			["Running sessions keep their effort until restarted", "secondary"],
		]);
	});

	it("shows a failed flip's exit and output, not a done state, whatever the status reads", async () => {
		const { panel } = await panelFlipping(RUNNING, {
			code: 2,
			stderr: "error: cannot place the burn-mode marker\n",
		});
		await panel.click(BURN_ROW);
		const rows = burnRows(panel);
		expect(summary(rows)).toEqual([
			["Burn mode  [!]", "name"],
			["burn-mode.sh on: exit 2", "value"],
			["error: cannot place the burn-mode marker", "secondary"],
			["Click runs burn-mode.sh on", "secondary"],
		]);
		expect(rows[0].control?.state).toBe("failed");
		expect(panel.view.presses.burn.pending).toBeNull();
	});

	it("shows a half-flip's exit and output, and the plan it left", async () => {
		const stuck = running({ on: true, disagreeing: [Plan], error: null });
		const { panel, setStatus } = await panelFlipping(running(BURN_ON), Stuck);
		setStatus(stuck);
		await panel.click(BURN_ROW);
		const rows = burnRows(panel);
		expect(rows.map((r) => r.text)).toEqual([
			"Burn mode  [!]",
			`Not at the burn effort: ${Plan}`,
			"burn-mode.sh off: exit 1",
			"error: still on the burn effort after off:",
			`  ${Plan}`,
			"burn mode: on",
			`  ${Plan} claude-opus-5-5 effort=high`,
			"Click runs burn-mode.sh off",
		]);
		expect(rows[0].control?.state).toBe("failed");
	});

	it("reads a plan left at the burn effort as no done state, with no flip of its own", () => {
		const rows = burnRowsOf({
			status: running({ on: false, disagreeing: [Plan], error: null }),
		});
		expect(rows[0].control?.state).toBe("failed");
		expect(rows[1]).toMatchObject({
			text: `At the burn effort: ${Plan}`,
			role: "value",
		});
		expect(rows[2].text).toBe("Click runs burn-mode.sh on");
	});

	it("holds a failed flip's report across reads that still show it", async () => {
		const { panel } = await panelFlipping(RUNNING, Stuck);
		await panel.click(BURN_ROW);
		await panel.refreshStatus();
		expect(burnRows(panel)[0].control?.state).toBe("failed");
	});

	it("drops the report once a read shows the flip finished elsewhere", async () => {
		const { panel, setStatus } = await panelFlipping(running(BURN_ON), Stuck);
		await panel.click(BURN_ROW);
		setStatus(RUNNING);
		await panel.refreshStatus();
		expect(burnRows(panel).map((r) => r.text)).toEqual(["Burn mode  [off]"]);
	});

	it.each([
		[
			"a half-flip reading on",
			running({ on: true, disagreeing: [Plan], error: null }),
			"off",
		],
		["a failed on that moved nothing", RUNNING, "on"],
	])(
		"runs the opposite of the marker after %s",
		async (_name, status, verb) => {
			const { flips, panel } = await panelFlipping(status, { code: 1 });
			await panel.click(BURN_ROW);
			await panel.click(BURN_ROW);
			expect(flips).toEqual([[verb], [verb]]);
		},
	);

	it("clears the report on the next clean flip", async () => {
		const { panel, setStatus } = await panelFlipping(
			running(BURN_ON),
			Stuck,
			{},
		);
		await panel.click(BURN_ROW);
		setStatus(RUNNING);
		await panel.click(BURN_ROW);
		expect(burnRows(panel)[0].control?.state).toBe("off");
		expect(burnRows(panel)[1].text).toBe(
			"Running sessions keep their effort until restarted",
		);
	});

	it("shows a warning on exit 0 beside the observed state, and holds it past the read", async () => {
		const warning =
			"warning: skipping .claude2/settings.json — it resolves to nothing";
		const { panel, setStatus } = await panelFlipping(RUNNING, {
			stderr: `${warning}\n`,
		});
		setStatus(running(BURN_ON));
		await panel.click(BURN_ROW);
		await panel.refreshStatus();
		expect(burnRows(panel).map((r) => r.text)).toEqual([
			"Burn mode  [on]",
			"burn-mode.sh on: exit 0",
			warning,
		]);
	});

	it("shows a script that cannot start as a failure", async () => {
		const { panel } = await panelFlipping(RUNNING, {
			code: 1,
			stderr: "spawn burn-mode.sh ENOENT",
		});
		await panel.click(BURN_ROW);
		const rows = burnRows(panel);
		expect(rows[0].control?.state).toBe("failed");
		expect(rows[2].text).toBe("spawn burn-mode.sh ENOENT");
	});
});

describe("the Away switch", () => {
	const Away = { ...RUNNING, mode: "away" };
	const awayRowsOf = (over: object) => {
		const rows = rowsOf(over);
		const at = rows.findIndex((r: Row) => r.text.startsWith("Away"));
		return rows.slice(at, at + BURN_INDEX - AWAY_INDEX);
	};

	it("reads normal, with the switch off", () => {
		const [row, sibling] = awayRowsOf({ status: RUNNING });
		expect(row.text).toBe("Away  [off]  normal");
		expect(row.control?.state).toBe("off");
		expect(sibling.text).toBe("");
	});

	it("reads on with no count before anything is handed off", () => {
		const [row] = awayRowsOf({ status: Away });
		expect(row.text).toBe("Away  [on]");
		expect(row.control?.state).toBe("on");
	});

	it("shows how many sessions were handed off while away", () => {
		const [row] = awayRowsOf({
			status: { ...Away, handedOffSinceAway: 2 },
		});
		expect(row.text).toBe("Away  [on]  2 handed off");
	});

	it("reads pending in either direction, claiming neither mode and no count", () => {
		const [turningOff] = awayRowsOf({
			status: { ...Away, handedOffSinceAway: 2 },
			...buildPressing("away", { on: false, landed: false }),
		});
		expect(turningOff.text).toBe("Away  […]  turning off…");
		expect(turningOff.control?.state).toBe("pending");
		const [turningOn] = awayRowsOf({
			status: RUNNING,
			...buildPressing("away", { on: true, landed: false }),
		});
		expect(turningOn.text).toBe("Away  […]  turning on…");
	});

	it("claims neither word while the status is unread, or with no control to read", () => {
		for (const over of [{}, { status: { ...RUNNING, mode: null } }]) {
			const [row] = awayRowsOf(over);
			expect(row.text).toBe("Away  [?]");
			expect(row.control?.state).toBe("unknown");
		}
	});

	it("keeps the rows below it in place, whatever it shows", () => {
		const cases = [
			{ status: RUNNING },
			{ status: Away, ...buildPressing("away", { on: false, landed: false }) },
			{ status: RUNNING, ...buildNoted("away", buildNote("refused")) },
		];
		for (const c of cases)
			expect(rowsOf(c)[BURN_INDEX].text).toMatch(/^Burn mode/);
	});

	async function clicked(
		status: object,
		command: string,
		after: object = status,
	) {
		let shown = status;
		const { calls, run } = runnerOf({
			[command]: () => {
				shown = after;
				return {};
			},
			"status --json": () => ({ stdout: JSON.stringify(shown) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		return { calls, panel };
	}

	it("turns away on through `set --away`", async () => {
		const { calls, panel } = await clicked(RUNNING, "set --away --json", Away);
		expect(calls).toContainEqual(["set", "--away", "--json"]);
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].text).toBe(
			"Away  [on]",
		);
	});

	it("turns away off through `set --normal`", async () => {
		const { calls, panel } = await clicked(
			Away,
			"set --normal --json",
			RUNNING,
		);
		expect(calls).toContainEqual(["set", "--normal", "--json"]);
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].text).toBe(
			"Away  [off]  normal",
		);
	});

	it("works with the loop stopped or paused, either way", async () => {
		const stopped = await clicked(STOPPED, "set --away --json");
		expect(stopped.calls).toContainEqual(["set", "--away", "--json"]);
		const paused = await clicked(
			{ ...PAUSED_BY_FOUNDER, mode: "away" },
			"set --normal --json",
		);
		expect(paused.calls).toContainEqual(["set", "--normal", "--json"]);
	});

	it("runs nothing before a read, or with no control to read", async () => {
		const { calls, run } = runnerOf({
			"status --json": showing({ ...RUNNING, mode: null }),
		});
		const panel = panelOver(run);
		await panel.click(AWAY_ROW);
		expect(calls).toEqual([]);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		expect(calls).toEqual([["status", "--json"]]);
	});

	it("reads normal once a status read shows the automatic return, and turns on again", async () => {
		let shown: object = { ...Away, handedOffSinceAway: 2 };
		const { calls, run } = runnerOf({
			"set --away --json": () => ({}),
			"status --json": () => ({ stdout: JSON.stringify(shown) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].text).toBe(
			"Away  [on]  2 handed off",
		);
		shown = RUNNING;
		await panel.refreshStatus();
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].text).toBe(
			"Away  [off]  normal",
		);
		await panel.click(AWAY_ROW);
		expect(calls).toContainEqual(["set", "--away", "--json"]);
	});

	it("holds the word until a read after the command, taking a second click as nothing", async () => {
		const { held, release } = heldUntil();
		const calls: string[][] = [];
		let shown: object = RUNNING;
		const run = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "set") {
				await held;
				shown = Away;
			}
			return { code: 0, stdout: JSON.stringify(shown), stderr: "" };
		};
		const panel = panelOver(run);
		await panel.refreshStatus();
		const press = panel.click(AWAY_ROW);
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].control.state).toBe(
			"pending",
		);
		await panel.refreshStatus();
		expect(panel.view.presses.away.pending).not.toBeNull();
		await panel.click(AWAY_ROW);
		expect(calls.filter((c) => c[0] === "set")).toHaveLength(1);
		release();
		await press;
		expect(panel.view.presses.away.pending).toBeNull();
		expect(buildRows(panel.view, LATER, WIDE)[AWAY_INDEX].control.state).toBe(
			"on",
		);
	});

	it("clears on the command's refusal and shows it on its own row, then blanks it", async () => {
		const { run } = runnerOf({
			"set --away --json": () => ({
				code: 1,
				stdout: buildRefusedStdout("busy"),
			}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		expect(panel.view.presses.away.pending).toBeNull();
		const rows = buildRows(panel.view, AT, WIDE);
		expect(rows[AWAY_INDEX].control.state).toBe("off");
		expect(rows[AWAY_INDEX + 1]).toMatchObject({
			text: "busy",
			role: "value",
		});
		expect(rows[3].text).toBe(MACHINE_FULL);
		expect(buildRows(panel.view, AT + 60_000, WIDE)[AWAY_INDEX + 1].text).toBe(
			"",
		);
	});

	it("shows the command's warning on a loop with no process, then blanks it", async () => {
		let shown: object = STOPPED;
		const { run } = runnerOf({
			"set --away --json": () => {
				shown = { ...STOPPED, mode: "away" };
				return {
					stdout: JSON.stringify({
						refused: null,
						warning: {
							reason: "not running",
							remedy: "this holds from its next start",
							box: null,
						},
						lines: ["mode:      away"],
					}),
				};
			},
			"status --json": () => ({ stdout: JSON.stringify(shown) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		const rows = buildRows(panel.view, AT, WIDE);
		expect(rows[AWAY_INDEX].text).toBe("Away  [on]");
		expect(rows[AWAY_INDEX + 1]).toMatchObject({
			text: "not running; this holds from its next start",
			role: "value",
		});
		expect(buildRows(panel.view, AT + 60_000, WIDE)[AWAY_INDEX + 1].text).toBe(
			"",
		);
	});

	it("says why a click does nothing with no control to read, and nothing before a read", () => {
		const [, sibling] = awayRowsOf({ status: { ...RUNNING, mode: null } });
		expect(sibling.text).toBe("No loop settings to change: run `start`");
		expect(awayRowsOf({})[1].text).toBe("");
	});

	it("never marks the loop switch pending mid-press", async () => {
		const { held, release } = heldUntil();
		const run = async (argv: string[]) => {
			if (argv[0] === "set") await held;
			return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
		};
		const panel = panelOver(run);
		await panel.refreshStatus();
		const press = panel.click(AWAY_ROW);
		const rows = buildRows(panel.view, LATER, WIDE);
		expect(rows[AWAY_INDEX].control.state).toBe("pending");
		expect(rows[0].control.state).toBe("on");
		release();
		await press;
	});
});

describe("the Repos section", () => {
	const repo = (name: string, ticked: boolean, disabled?: string) => ({
		name,
		root: `/home/x/${name}`,
		ticked,
		disabled: disabled ?? null,
	});
	const Repos = [
		repo("design-vault", false),
		repo("mantahostels", true),
		repo("opted-out", false, "refillLoop: false"),
		repo("workflow-core", true),
	];
	const WithRepos = { ...RUNNING, repos: Repos };
	const reposOf = (over: object) => {
		const rows = rowsOf(over);
		return rows.slice(rows.findIndex((r) => r.text === "Repos"));
	};
	const boxOf = (rows: Row[], name: string) =>
		rows.find((r) => r.control?.name === name);
	const rowOfBox = (panel: { view: object }, name: string) =>
		SWITCH_ROW +
		buildRows(panel.view, LATER, WIDE).findIndex(
			(r: Row) => r.control?.name === name,
		);

	/* A panel over `status`; `show` changes what later reads answer. */
	function repoPanel(status: object, failure?: object) {
		let shown = status;
		const calls: string[][] = [];
		const run = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "status")
				return { code: 0, stdout: JSON.stringify(shown), stderr: "" };
			return { code: 0, stdout: "", stderr: "", ...failure };
		};
		const panel = panelOver(run);
		const show = (next: object) => {
			shown = next;
		};
		const presses = () => calls.filter((argv) => argv[0] !== "status");
		return { panel, show, presses };
	}

	it("counts the ticked boxes in the heading, its count in regular weight", () => {
		const [heading] = reposOf({ status: WithRepos });
		expect(heading).toEqual({
			text: "Repos",
			detail: "2 of 4 on",
			role: "name",
		});
		expect(buildFrame([heading], 80, 40)).toContain(
			`${ESC}[1m${ESC}[38;2;242;242;242mRepos${ESC}[22m  2 of 4 on`,
		);
	});

	it("leaves an opted-out tick out of the count", () => {
		const status = {
			...RUNNING,
			repos: [repo("a", true), repo("b", true, "refillLoop: false")],
		};
		expect(reposOf({ status })[0].detail).toBe("1 of 2 on");
		expect(boxOf(rowsOf({ status }), "b")?.control?.state).toBe("disabled");
	});

	it("draws a ticked name in regular weight, and an unticked one grey", () => {
		const rows = rowsOf({ status: WithRepos });
		expect(boxOf(rows, "workflow-core")).toMatchObject({
			text: "[✓] workflow-core",
			role: "value",
		});
		expect(boxOf(rows, "design-vault")).toMatchObject({
			text: "[ ] design-vault",
			role: "secondary",
		});
	});

	it("shows a disabled box with its reason beneath", () => {
		const rows = reposOf({ status: WithRepos });
		const at = rows.findIndex((r) => r.control?.name === "opted-out");
		expect(rows[at]).toMatchObject({
			text: "[-] opted-out",
			role: "secondary",
			control: { state: "disabled" },
		});
		expect(rows[at + 1].text).toBe("refillLoop: false");
		expect(rows[at + 1].control).toBeUndefined();
	});

	it("shows a checkout found later unticked, the count's total grown", () => {
		const status = {
			...WithRepos,
			repos: [...Repos, repo("found-later", false)],
		};
		const rows = reposOf({ status });
		expect(rows[0].detail).toBe("2 of 5 on");
		expect(boxOf(rows, "found-later")?.control?.state).toBe("unticked");
	});

	it("says beside the boxes that an unticked repo still supplies blockers", () => {
		const texts = reposOf({ status: WithRepos }).map((r) => r.text);
		const noteAt = texts.indexOf("An unticked repo still supplies");
		expect(texts[noteAt + 1]).toBe("the blockers of served issues");
		expect(texts[noteAt - 1]).toBe("");
	});

	it("spaces a title from its boxes and each box from the next by one row", () => {
		const status = { ...RUNNING, repos: [repo("a", true), repo("b", false)] };
		expect(reposOf({ status }).map((r) => r.text)).toEqual([
			"Repos",
			"",
			"[✓] a",
			"",
			"[ ] b",
			"",
			"An unticked repo still supplies",
			"the blockers of served issues",
			"",
			"↑↓ move · space change",
			"Esc leave",
		]);
	});

	it("draws only the rows that fit, so none stacks on the last line", () => {
		const frame = buildFrame(rowsOf({ status: WithRepos }), 80, 21);
		expect(frame).toContain(`${ESC}[21;3H`);
		expect(frame).not.toContain(`${ESC}[22;3H`);
	});

	it("draws no section before the first read", () => {
		const texts = rowsOf({}).map((r) => r.text);
		expect(texts).not.toContain("Repos");
	});

	it("ticks an unticked repo on a press, reading pending until a read shows it", async () => {
		const { held, release } = heldUntil();
		const calls: string[][] = [];
		let shown = WithRepos;
		const panel = panelOver(async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "status")
				return { code: 0, stdout: JSON.stringify(shown), stderr: "" };
			await held;
			return { code: 0, stdout: "", stderr: "" };
		});
		await panel.refreshStatus();
		const clicked = panel.click(rowOfBox(panel, "design-vault"));
		const rows = buildRows(panel.view, LATER, WIDE);
		expect(boxOf(rows, "design-vault")).toMatchObject({
			text: "[…] design-vault  turning on…",
			control: { state: "pending" },
		});
		expect(rows.find((r: Row) => r.text === "Repos").detail).toBe("2 of 4 on");
		await panel.refreshStatus();
		expect(
			boxOf(buildRows(panel.view, LATER, WIDE), "design-vault")?.control?.state,
		).toBe("pending");
		await panel.click(rowOfBox(panel, "design-vault"));
		shown = {
			...RUNNING,
			repos: Repos.map((r) =>
				r.name === "design-vault" ? { ...r, ticked: true } : r,
			),
		};
		release();
		await clicked;
		expect(calls.filter((argv) => argv[0] !== "status")).toEqual([
			["set", "--tick", "design-vault", "--json"],
		]);
		expect(
			boxOf(buildRows(panel.view, LATER, WIDE), "design-vault")?.control?.state,
		).toBe("ticked");
	});

	it("unticks a ticked repo on a press", async () => {
		const { panel, presses, show } = repoPanel(WithRepos);
		await panel.refreshStatus();
		const row = rowOfBox(panel, "workflow-core");
		show({
			...RUNNING,
			repos: Repos.map((r) =>
				r.name === "workflow-core" ? { ...r, ticked: false } : r,
			),
		});
		await panel.click(row);
		expect(presses()).toEqual([["set", "--untick", "workflow-core", "--json"]]);
		expect(
			boxOf(buildRows(panel.view, LATER, WIDE), "workflow-core"),
		).toMatchObject({
			text: "[ ] workflow-core",
			control: { state: "unticked" },
		});
	});

	it("runs nothing on a press on a disabled box, or on its reason", async () => {
		const { panel, presses } = repoPanel(WithRepos);
		await panel.refreshStatus();
		const row = rowOfBox(panel, "opted-out");
		await panel.click(row);
		await panel.click(row + 1);
		expect(presses()).toEqual([]);
	});

	it("runs nothing on a press on the heading or the note", async () => {
		const { panel, presses } = repoPanel(WithRepos);
		await panel.refreshStatus();
		const rows = buildRows(panel.view, LATER, WIDE);
		await panel.click(
			SWITCH_ROW + rows.findIndex((r: Row) => r.text === "Repos"),
		);
		await panel.click(SWITCH_ROW + rows.length - 1);
		expect(presses()).toEqual([]);
	});

	it("shows a refusal in the gap below its box, moving no box, and clears the mark", async () => {
		const { panel } = repoPanel(WithRepos, {
			code: 2,
			stdout: buildRefusedStdout(
				"design-vault: no workflow-core config",
				undefined,
				"design-vault",
			),
		});
		await panel.refreshStatus();
		const rowsBefore = buildRows(panel.view, LATER, WIDE);
		const row = rowOfBox(panel, "design-vault");
		await panel.click(row);
		const rows = buildRows(panel.view, AT, WIDE);
		expect(rows).toHaveLength(rowsBefore.length);
		expect(boxOf(rows, "design-vault")?.control?.state).toBe("unticked");
		expect(rows[row - SWITCH_ROW + 1]).toEqual({
			text: "design-vault: no workflow-core config",
			role: "value",
		});
		const expired = buildRows(panel.view, AT + 10_000, WIDE);
		expect(expired[row - SWITCH_ROW + 1].text).toBe("");
	});
});

describe("the Goal section", () => {
	const SetAt = AT - 3_600_000;
	const goalOf = (over: object = {}) => ({
		form: "drain",
		text: "drain #2518",
		refs: [{ repo: "wc", number: 2518 }],
		setAt: SetAt,
		set: [],
		open: 5,
		takeable: 2,
		running: 1,
		readAt: AT,
		doneAt: null,
		...over,
	});
	const Live = {
		...goalOf(),
		set: [1, 2, 3, 4, 5].map((number) => ({
			repo: "o/wc",
			number,
			title: "t",
		})),
	};
	const WithGoal = { ...RUNNING, goal: Live };
	const Done = {
		...RUNNING,
		goal: goalOf({ open: 0, takeable: 0, running: 0, doneAt: AT }),
	};
	const Unread = {
		...RUNNING,
		goal: goalOf({
			set: null,
			open: null,
			takeable: null,
			running: null,
			readAt: null,
		}),
	};
	const Caption = ["Click to change it", "Enter to save · Esc to cancel"];
	const Enter = { name: "enter" };
	const Esc = { name: "escape" };

	const goalRows = (over: object) => {
		const rows = rowsOf(over);
		const at = rows.findIndex((r) => r.text.startsWith("Goal"));
		return rows.slice(at, at + 4);
	};
	const rowWhere = (panel: { view: object }, test: (r: Row) => boolean) =>
		SWITCH_ROW + buildRows(panel.view, AT, WIDE).findIndex(test);
	const switchRow = (panel: { view: object }) =>
		rowWhere(panel, (r) => r.text.startsWith("Goal"));
	const fieldRow = (panel: { view: object }) => switchRow(panel) + 2;

	/* A panel whose reads answer `status`, and whose commands answer `answer`. A typed
	 * topic needs `resolveTopic`; the default answers nothing. */
	async function goalPanel(
		status: object,
		answer: object = {},
		resolveTopic: unknown = noop,
	) {
		let shown = status;
		const calls: string[][] = [];
		const run = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "status")
				return { code: 0, stdout: JSON.stringify(shown), stderr: "" };
			return { code: 0, stdout: "", stderr: "", ...answer };
		};
		const panel = panelOver(run, run, resolveTopic);
		await panel.refreshStatus();
		return {
			panel,
			presses: () => calls.filter((argv) => argv[0] !== "status"),
			show: (next: object) => {
				shown = next;
			},
		};
	}
	const Found = async () => ({
		issues: [
			{ repo: "wc", number: 5, title: "Speed the suite" },
			{ repo: "wc", number: 7, title: "Rename a flag" },
		],
		dropped: 0,
	});
	type GoalPanel = Awaited<ReturnType<typeof goalPanel>>["panel"];
	async function typeGoal(panel: GoalPanel, text: string) {
		await panel.click(fieldRow(panel));
		panel.view.goalEdit = { text: "", caret: 0 };
		await panel.pressKey({ text });
		await panel.pressKey(Enter);
	}

	describe("what it shows", () => {
		it("shows a live goal with its progress", () => {
			expect(goalRows({ status: WithGoal })[2]).toMatchObject({
				text: "drain #2518 — 5 open, 2 takeable, 1 running",
				role: "value",
			});
			expect(goalRows({ status: WithGoal })[0]).toMatchObject({
				text: "Goal  [on]",
				role: "name",
				control: { id: "goal", state: "on" },
			});
		});

		it("shows a goal no read has reached as typed, with no counts", () => {
			expect(goalRows({ status: Unread })[2].text).toBe("drain #2518");
		});

		it("shows a finished goal, its switch still on until cleared", () => {
			const rows = goalRows({ status: Done });
			expect(rows[2].text).toBe("drain #2518 — done 14:05; running bare");
			expect(rows[0].control?.state).toBe("on");
		});

		it("shows a cleared goal off and running bare", () => {
			const rows = goalRows({ status: RUNNING });
			expect(rows[0]).toMatchObject({
				text: "Goal  [off]",
				control: { state: "off" },
			});
			expect(rows[2]).toMatchObject({
				text: "No goal: running bare",
				role: "secondary",
			});
		});

		it("draws neither word until the status reads", () => {
			expect(goalRows({ status: null })[0].control?.state).toBe("unknown");
		});

		it("says a press is on its way, the old goal showing beneath", () => {
			const rows = goalRows({
				status: WithGoal,
				...buildPressing("goal", { on: true, landed: false }),
			});
			expect(rows[0]).toMatchObject({
				text: "Goal  […]  setting…",
				control: { state: "pending" },
			});
			expect(rows[2].text).toContain("drain #2518");
			expect(
				goalRows({
					status: WithGoal,
					...buildPressing("goal", { on: false, landed: false }),
				})[0].text,
			).toBe("Goal  […]  turning off…");
		});
	});

	describe("its two-line caption", () => {
		const refused = buildNote(
			"wc#5 is in wc, which is not ticked",
			"tick wc first",
		);
		const states: [string, object][] = [
			["unread", { status: null }],
			["no goal", { status: RUNNING }],
			["a live goal", { status: WithGoal }],
			["a done goal", { status: Done }],
			[
				"editing",
				{ status: WithGoal, goalEdit: { text: "drain #1", caret: 8 } },
			],
			[
				"a pending press",
				{
					status: WithGoal,
					...buildPressing("goal", { on: true, landed: false }),
				},
			],
			["a refusal", { status: WithGoal, ...buildNoted("goal", refused) }],
			[
				"a note of one clause",
				{ status: WithGoal, ...buildNoted("goal", buildNote("exit 1")) },
			],
		];

		it.each(states)("keeps what is below it in place: %s", (_, over) => {
			const rows = rowsOf({ status: WithGoal, ...over });
			const at = rows.findIndex((r) => r.text.startsWith("Goal"));
			/* Heading, gap, field, two caption rows, then the section gap. */
			expect(rows.slice(at + 5, at + 7).map((r) => r.text)).toEqual(["", ""]);
		});

		it("reads the same with a goal or none, and while editing", () => {
			for (const over of [
				{ status: RUNNING },
				{ status: WithGoal },
				{ status: WithGoal, goalEdit: { text: "x", caret: 1 } },
			]) {
				const rows = goalRows(over);
				expect(rows.slice(3, 4).map((r) => r.text)).toEqual([Caption[0]]);
				expect(rowsOf(over).map((r) => r.text)).toContain(Caption[1]);
			}
		});

		it("gives way to a refusal for as long as a note shows, then returns", () => {
			const rows = (now: number) =>
				buildRows(
					view({ status: WithGoal, ...buildNoted("goal", refused) }),
					now,
					WIDE,
				).map((r: Row) => r.text);
			expect(rows(LATER)).toContain("wc#5 is in wc, which is not ticked");
			expect(rows(LATER)).toContain("tick wc first");
			expect(rows(LATER)).not.toContain(Caption[0]);
			expect(rows(LATER + 10_000)).toContain(Caption[0]);
		});

		it("shows a note's reason and remedy on their own rows", () => {
			const note = buildNote("not running", "this holds from its next start");
			const texts = rowsOf({
				status: WithGoal,
				...buildNoted("goal", note),
			}).map((r) => r.text);
			expect(texts).toContain("not running");
			expect(texts).toContain("this holds from its next start");
		});
	});

	describe("the switch", () => {
		it("clears the goal, and only that", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(switchRow(panel));
			expect(presses()).toEqual([["set", "--clear-goal", "--json"]]);
		});

		it("clears a finished goal too", async () => {
			const { panel, presses } = await goalPanel(Done);
			await panel.click(switchRow(panel));
			expect(presses()).toEqual([["set", "--clear-goal", "--json"]]);
		});

		it("opens the empty field where there is no goal, running nothing", async () => {
			const { panel, presses } = await goalPanel(RUNNING);
			await panel.click(switchRow(panel));
			expect(presses()).toEqual([]);
			expect(panel.view.goalEdit).toEqual({ text: "", caret: 0 });
		});

		it("does nothing before a read, or on a press still pending", async () => {
			const before = await goalPanel(WithGoal);
			before.panel.view.status = null;
			await before.panel.click(switchRow(before.panel));
			expect(before.presses()).toEqual([]);
			expect(before.panel.view.goalEdit).toBeNull();

			const pending = await goalPanel(WithGoal);
			pending.panel.view.presses.goal.pending = { on: true, landed: false };
			await pending.panel.click(switchRow(pending.panel));
			expect(pending.presses()).toEqual([]);
		});

		it("holds its pending word until a read after the command", async () => {
			const { held, release } = heldUntil();
			let readsDone = 0;
			const run = async (argv: string[]) => {
				if (argv[0] === "status") {
					readsDone += 1;
					return { code: 0, stdout: JSON.stringify(RUNNING), stderr: "" };
				}
				await held;
				return { code: 0, stdout: "", stderr: "" };
			};
			const panel = panelOver(run);
			panel.view.status = WithGoal;
			const press = panel.click(switchRow(panel));
			expect(panel.view.presses.goal.pending).toMatchObject({ on: false });
			release();
			await press;
			expect(readsDone).toBe(1);
			expect(panel.view.presses.goal.pending).toBeNull();
			expect(panel.view.status.goal).toBeNull();
		});
	});

	describe("the field", () => {
		it("starts an edit from the current goal, the caret at its end", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			expect(panel.view.goalEdit).toEqual({ text: "drain #2518", caret: 11 });
			expect(presses()).toEqual([]);
			const row = goalRows({ status: WithGoal, ...panel.view })[2];
			expect(row).toMatchObject({ text: "drain #2518", caret: 11 });
		});

		it("takes keys as a small edit of what is there", async () => {
			const { panel } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ name: "backspace" });
			await panel.pressKey({ text: "9" });
			await panel.pressKey({ name: "home" });
			await panel.pressKey({ name: "delete" });
			await panel.pressKey({ name: "right" });
			await panel.pressKey({ name: "left" });
			await panel.pressKey({ name: "left" });
			await panel.pressKey({ text: "d" });
			await panel.pressKey({ name: "end" });
			expect(panel.view.goalEdit).toEqual({ text: "drain #2519", caret: 11 });
		});

		it("keeps the caret inside the text", async () => {
			const { panel } = await goalPanel(RUNNING);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ name: "left" });
			await panel.pressKey({ name: "backspace" });
			await panel.pressKey({ name: "delete" });
			await panel.pressKey({ name: "right" });
			expect(panel.view.goalEdit).toEqual({ text: "", caret: 0 });
		});

		it("counts a character beyond one code unit as one", async () => {
			const { panel } = await goalPanel(RUNNING);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "a😀" });
			await panel.pressKey({ name: "backspace" });
			expect(panel.view.goalEdit).toEqual({ text: "a", caret: 1 });
		});

		it("changes nothing on Esc", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "9" });
			await panel.pressKey(Esc);
			expect(panel.view.goalEdit).toBeNull();
			expect(presses()).toEqual([]);
		});

		it("takes no key at all with the field closed", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			for (const pressed of [{ text: "p" }, Enter, Esc, { name: "left" }])
				await panel.pressKey(pressed);
			expect(presses()).toEqual([]);
			expect(panel.view.goalEdit).toBeNull();
		});

		it.each([
			["2518,2520", "--goal=2518,2520"],
			["#2518", "--goal=#2518"],
			["drain #2518", "--goal=drain #2518"],
			["drain wc#2518", "--goal=drain wc#2518"],
			["unblock #2518", "--goal=unblock #2518"],
			["  unblock wc#2518 ", "--goal=unblock wc#2518"],
		])("sends %j through set --goal", async (typed, flag) => {
			const { panel, presses } = await goalPanel(WithGoal);
			await typeGoal(panel, typed);
			expect(presses()).toEqual([["set", flag, "--json"]]);
			expect(panel.view.goalEdit).toBeNull();
		});

		it.each(["--pause", "--help", "--", "--untick wc"])(
			"keeps typed %j to the one argument, so it reaches no other flag",
			async (typed) => {
				const { panel, presses } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, typed);
				await panel.pressKey(Enter);
				expect(presses()).toEqual([
					["set", "--goal-issues=wc#5,wc#7", `--goal-text=${typed}`, "--json"],
				]);
			},
		);

		describe("a topic", () => {
			const Ticked = {
				...WithGoal,
				repos: [
					{ name: "wc", root: "/h/wc", ticked: true, disabled: null },
					{ name: "off", root: "/h/off", ticked: false, disabled: null },
					{ name: "out", root: "/h/out", ticked: true, disabled: "opted out" },
				],
			};
			const texts = (panel: GoalPanel) =>
				buildRows(panel.view, AT, WIDE).map((r: { text: string }) => r.text);
			const rowOf = (panel: GoalPanel, text: string) =>
				rowWhere(panel, (r) => r.text === text);
			const SaveTwo = "Save these 2 · Enter";
			const Cancel = "Cancel · Esc";

			it("says it is resolving, writing nothing, from the ticked repos alone", async () => {
				let finish: (found: object) => void = noop;
				const resolve = vi.fn(
					() =>
						new Promise((done) => {
							finish = done;
						}),
				);
				const { panel, presses } = await goalPanel(Ticked, {}, resolve);
				const typed = typeGoal(panel, "clear Phase 0");
				await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
				expect(texts(panel)).toContain('resolving "clear Phase 0"…');
				const [text, repos] = resolve.mock.calls[0] as unknown as [
					string,
					{ name: string }[],
				];
				expect(text).toBe("clear Phase 0");
				expect(repos.map((r) => r.name)).toEqual(["wc"]);
				expect(presses()).toEqual([]);
				finish(await Found());
				await typed;
			});

			it("shows the set with titles, and saves it only on the confirm press", async () => {
				const { panel, presses } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, "clear Phase 0");
				const rows = buildRows(panel.view, AT, WIDE);
				expect(rows).toEqual(
					expect.arrayContaining([
						expect.objectContaining({ text: "clear Phase 0" }),
						expect.objectContaining({ text: "#5", detail: "Speed the suite" }),
						expect.objectContaining({ text: "#7", detail: "Rename a flag" }),
					]),
				);
				expect(presses()).toEqual([]);
				await panel.click(rowOf(panel, SaveTwo));
				expect(presses()).toEqual([
					[
						"set",
						"--goal-issues=wc#5,wc#7",
						"--goal-text=clear Phase 0",
						"--json",
					],
				]);
				expect(panel.view.goalResolve).toBeNull();
			});

			it("holds the set in the Repos section's place, so no box moves under a click", async () => {
				const { panel, presses } = await goalPanel(Ticked, {}, Found);
				const before = texts(panel).indexOf("Repos");
				await typeGoal(panel, "topic");
				expect(texts(panel)).not.toContain("Repos");
				expect(texts(panel).indexOf("#5")).toBe(before);
				await panel.click(rowOf(panel, "#5"));
				expect(presses()).toEqual([]);
				await panel.pressKey({ name: "escape" });
				expect(texts(panel).indexOf("Repos")).toBe(before);
			});

			it("offers nothing to save on the row Save lands on while it resolves", async () => {
				let finish: (found: object) => void = noop;
				const resolve = () =>
					new Promise((done) => {
						finish = done;
					});
				const { panel, presses } = await goalPanel(WithGoal, {}, resolve);
				const typed = typeGoal(panel, "topic");
				await vi.waitFor(() => expect(texts(panel)).toContain(Cancel));
				const saveRow = rowOf(panel, Cancel) - 1;
				await panel.click(saveRow);
				expect(presses()).toEqual([]);
				await panel.click(rowOf(panel, Cancel));
				expect(panel.view.goalResolve).toBeNull();
				finish(await Found());
				await typed;
			});

			it("gives the read's fault, asking nothing, where the status has gone", async () => {
				const resolve = vi.fn(Found);
				const { panel, presses } = await goalPanel(WithGoal, {}, resolve);
				await panel.click(fieldRow(panel));
				panel.view.goalEdit = { text: "topic", caret: 5 };
				panel.view.status = null;
				panel.view.readError = "status --json: bad";
				await panel.pressKey(Enter);
				expect(resolve).not.toHaveBeenCalled();
				expect(panel.view.presses.goal.note).toMatchObject({
					reason: "Topic not resolved",
					remedy: "status --json: bad",
				});
				expect(presses()).toEqual([]);
			});

			it("clears a held reason on a repo press", async () => {
				const { panel } = await goalPanel(Ticked, {}, async () => ({
					why: "no repo is ticked",
				}));
				await typeGoal(panel, "topic");
				expect(panel.view.presses.goal.note?.held).toBe(true);
				await panel.click(rowOf(panel, "[✓] wc"));
				expect(panel.view.presses.goal.note).toBeNull();
			});

			it("names each ref's repo and counts what was dropped where the set spans repos", async () => {
				const { panel } = await goalPanel(WithGoal, {}, async () => ({
					issues: [
						{ repo: "wc", number: 5, title: "A" },
						{ repo: "books", number: 5, title: "B" },
					],
					dropped: 1,
				}));
				await typeGoal(panel, "topic");
				expect(texts(panel)).toEqual(
					expect.arrayContaining([
						"wc#5",
						"books#5",
						"1 dropped: not open in a ticked repo",
					]),
				);
			});

			it.each([
				["Esc", (p: GoalPanel) => p.pressKey({ name: "escape" })],
				["its row", (p: GoalPanel) => p.click(rowOf(p, Cancel))],
				["the switch", (p: GoalPanel) => p.click(switchRow(p))],
			])("cancels on %s, leaving the old goal", async (_, cancel) => {
				const { panel, presses } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, "topic");
				await cancel(panel);
				expect(presses()).toEqual([]);
				expect(panel.view.goalResolve).toBeNull();
				expect(goalRows(panel.view)[2].text).toContain("drain #2518");
			});

			it("aborts the call on Esc, and a late answer shows nothing", async () => {
				let finish: (found: object) => void = noop;
				let aborted: AbortSignal | undefined;
				const resolve = (_t: string, _r: unknown, signal: AbortSignal) => {
					aborted = signal;
					return new Promise((done) => {
						finish = done;
					});
				};
				const { panel } = await goalPanel(WithGoal, {}, resolve);
				const typed = typeGoal(panel, "topic");
				await vi.waitFor(() => expect(aborted).toBeDefined());
				await panel.pressKey({ name: "escape" });
				expect(aborted?.aborted).toBe(true);
				finish(await Found());
				await typed;
				expect(panel.view.goalResolve).toBeNull();
				expect(panel.view.presses.goal.note).toBeNull();
			});

			it("shows a failure's reason past the note time, the old goal in place", async () => {
				const { panel, presses } = await goalPanel(WithGoal, {}, async () => ({
					why: "the model named no issue",
				}));
				await typeGoal(panel, "topic");
				const shown = buildRows(panel.view, AT + 3_600_000, WIDE).map(
					(r: { text: string }) => r.text,
				);
				expect(shown).toContain("Topic not resolved");
				expect(shown).toContain("the model named no issue");
				expect(presses()).toEqual([]);
				expect(goalRows(panel.view)[2].text).toContain("drain #2518");
			});

			it("shows `set`'s refusal of a confirmed set, the old goal in place", async () => {
				const { panel } = await goalPanel(
					WithGoal,
					{
						code: 1,
						stdout: buildRefusedStdout("wc#5 is closed", "name an open issue"),
					},
					Found,
				);
				await typeGoal(panel, "topic");
				await panel.pressKey(Enter);
				expect(texts(panel)).toContain("wc#5 is closed");
				expect(goalRows(panel.view)[2].text).toContain("drain #2518");
			});

			it("reopens the field from the topic on a click on it", async () => {
				const { panel } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, "topic");
				await panel.click(rowOf(panel, "topic"));
				expect(panel.view.goalEdit?.text).toBe("topic");
				expect(panel.view.goalResolve).toBeNull();
			});

			it("keeps a confirmed set as resolved through later reads, asking again only on a new resolve", async () => {
				const resolve = vi.fn(Found);
				const Saved = {
					...RUNNING,
					goal: goalOf({
						form: "topic",
						text: "clear Phase 0",
						refs: [{ repo: "wc", number: 5 }],
					}),
				};
				const { panel } = await goalPanel(Saved, {}, resolve);
				await panel.refreshStatus();
				await panel.refreshStatus();
				expect(resolve).not.toHaveBeenCalled();
				await panel.click(fieldRow(panel));
				await panel.pressKey(Enter);
				expect(resolve).toHaveBeenCalledTimes(1);
			});

			it("leaves keys alone but Enter and Esc", async () => {
				const { panel, presses } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, "topic");
				await panel.pressKey({ text: "x" });
				expect(panel.view.goalResolve?.text).toBe("topic");
				expect(presses()).toEqual([]);
			});
		});

		it("closes on a blank Enter, setting nothing", async () => {
			const { panel, presses } = await goalPanel(RUNNING);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "   " });
			await panel.pressKey(Enter);
			expect(panel.view.goalEdit).toBeNull();
			expect(panel.view.presses.goal.pending).toBeNull();
			expect(presses()).toEqual([]);
		});

		it("shows the new goal once a read shows it", async () => {
			const { panel, show } = await goalPanel(WithGoal);
			show({
				...RUNNING,
				goal: goalOf({ text: "#7", set: null, open: null }),
			});
			await typeGoal(panel, "#7");
			expect(panel.view.presses.goal.pending).toBeNull();
			expect(goalRows({ ...panel.view })[2].text).toBe("#7");
		});

		it("drops what was typed on a click elsewhere, which still acts once", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "9" });
			await panel.click(AWAY_ROW);
			expect(panel.view.goalEdit).toBeNull();
			expect(presses()).toEqual([["set", "--away", "--json"]]);
		});

		it("stays open on a click on itself", async () => {
			const { panel } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "9" });
			await panel.click(fieldRow(panel));
			expect(panel.view.goalEdit?.text).toBe("drain #25189");
		});

		it("closes on a second press of the switch with no goal, setting nothing", async () => {
			const { panel, presses } = await goalPanel(RUNNING);
			await panel.click(switchRow(panel));
			await panel.click(switchRow(panel));
			expect(panel.view.goalEdit).toBeNull();
			expect(presses()).toEqual([]);
		});

		it("cannot open while a press is pending", async () => {
			const { panel } = await goalPanel(WithGoal);
			panel.view.presses.goal.pending = { on: true, landed: false };
			await panel.click(fieldRow(panel));
			expect(panel.view.goalEdit).toBeNull();
		});
	});

	describe("a refused goal", () => {
		const NotTicked = buildRefusedStdout(
			"wc#5 is in wc, which is not ticked",
			"tick wc first",
			"wc",
		);

		it("shows in place, naming the box, and leaves the old goal showing", async () => {
			const { panel, presses } = await goalPanel(WithGoal, {
				code: 2,
				stdout: NotTicked,
			});
			await typeGoal(panel, "wc#5");
			expect(panel.view.presses.goal.pending).toBeNull();
			expect(presses()).toEqual([["set", "--goal=wc#5", "--json"]]);
			const rows: Row[] = buildRows(panel.view, AT, WIDE);
			const at = rows.findIndex((r) => r.text.startsWith("Goal"));
			expect(rows[at].control?.state).toBe("on");
			expect(rows.slice(at + 2, at + 5).map((r) => r.text)).toEqual([
				"drain #2518 — 5 open, 2 takeable, 1 running",
				"wc#5 is in wc, which is not ticked",
				"tick wc first",
			]);
			expect(panel.view.presses.goal).toMatchObject({
				pending: null,
				note: {
					reason: "wc#5 is in wc, which is not ticked",
					remedy: "tick wc first",
					box: "wc",
				},
			});
		});

		it("shows under the box at fault too, the boxes staying put", async () => {
			const Repo = { root: "/h/wc", ticked: false, disabled: null };
			const status = { ...WithGoal, repos: [{ ...Repo, name: "wc" }] };
			const { panel } = await goalPanel(status, {
				code: 1,
				stdout: NotTicked,
			});
			const before = buildRows(panel.view, AT, WIDE).length;
			await typeGoal(panel, "wc#5");
			const rows: Row[] = buildRows(panel.view, AT, WIDE);
			expect(rows).toHaveLength(before);
			const box = rows.findIndex((r) => r.control?.name === "wc");
			expect(rows[box + 1].text).toBe(
				"wc#5 is in wc, which is not ticked; tick wc first",
			);
			await panel.click(fieldRow(panel));
			const edited: Row[] = buildRows(panel.view, AT, WIDE);
			expect(edited[box + 1].text).toBe("");
		});

		it("shows stderr's first line where the command died before its object", async () => {
			const { panel } = await goalPanel(WithGoal, {
				code: 1,
				stderr: "spawn node ENOENT\nmore\n",
			});
			await typeGoal(panel, "wc#5");
			expect(panel.view.presses.goal.note).toMatchObject({
				reason: "spawn node ENOENT",
				remedy: null,
			});
		});

		it("is gone on the next edit", async () => {
			const { panel } = await goalPanel(WithGoal, {
				code: 2,
				stdout: NotTicked,
			});
			await typeGoal(panel, "wc#5");
			await panel.click(fieldRow(panel));
			expect(panel.view.presses.goal.note).toBeNull();
			expect(panel.view.goalEdit?.text).toBe("drain #2518");
		});

		it("changes no row above the Goal section", async () => {
			const { panel } = await goalPanel(
				{ ...WithGoal, repos: [] },
				{ code: 2, stdout: NotTicked },
			);
			const others = () =>
				buildRows(panel.view, AT, WIDE)
					.slice(0, switchRow(panel) - SWITCH_ROW)
					.map((r: Row) => r.text);
			const before = others();
			await typeGoal(panel, "wc#5");
			expect(others()).toEqual(before);
		});
	});

	describe("the frame", () => {
		const editing = (text: string, caret: number) => [
			{ text, role: "value", caret, control: { id: "goalField" } },
		];

		it("hides the cursor with no row being typed in", () => {
			const frame = buildFrame(rowsOf({ status: WithGoal }), 80, 60);
			expect(frame.startsWith(`${ESC}[?25l`)).toBe(true);
			expect(frame).not.toContain(`${ESC}[?25h`);
		});

		it("stands the cursor at the caret", () => {
			const frame = buildFrame(editing("drain #1", 2), 80, 60);
			expect(frame.endsWith(`${ESC}[2;5H${ESC}[?25h`)).toBe(true);
		});

		it("scrolls a long edit to keep the caret in view, cutting no end word", () => {
			const text = "x".repeat(50);
			const frame = buildFrame(editing(`${text}END`, 53), 24, 60);
			expect(frame).toContain("END");
			expect(frame).not.toContain("…");
			/* 20 cells wide, the caret in the last: column 3 + 19. */
			expect(frame.endsWith(`${ESC}[2;22H${ESC}[?25h`)).toBe(true);
		});

		it("shows no cursor where the row is below the pane", () => {
			const rows = [{ text: "a", role: "value" }, ...editing("b", 1)];
			expect(buildFrame(rows, 80, 2)).not.toContain(`${ESC}[?25h`);
		});
	});
});

describe("the spacing scale", () => {
	const blankRunBefore = (drawn: Row[], text: string) => {
		const at = drawn.findIndex((r) => r.text.startsWith(text));
		let blanks = 0;
		while (drawn[at - blanks - 1]?.text === "") blanks += 1;
		return blanks;
	};
	const repos = [
		{ name: "wc", root: "/h/wc", ticked: true, disabled: null },
		{ name: "dv", root: "/h/dv", ticked: false, disabled: null },
	];
	const rows = rowsOf({ status: { ...RUNNING, repos } });

	it("sets what Burn mode reports one row below its title", () => {
		const burnMode = { on: true, disagreeing: [".claude2"], error: null };
		const drawn = rowsOf({ status: { ...RUNNING, repos, burnMode } });
		expect(blankRunBefore(drawn, "Not at the burn effort")).toBe(1);
		expect(blankRunBefore(drawn, "Click runs")).toBe(0);
	});

	it.each([
		["a title to its first element: the loop's block", "3 launched", 1],
		["a title to its first element: the goal's field", "No goal", 1],
		["a title to its first element: the first box", "[✓] wc", 1],
		["siblings: Away to Burn mode", "Burn mode", 1],
		["siblings: one box to the next", "[ ] dv", 1],
		["siblings: the last box to the note", "An unticked repo", 1],
		["inside a text block: the loop's line 2", MACHINE_FULL, 0],
		["siblings: the loop's lines to the plan rows", "Weekly plan usage", 1],
		["inside a text block: the plan rows", ".claude3", 0],
		["inside a text block: the caption under the field", "Click to change", 0],
		["inside a text block: the caption's second line", "Enter to save", 0],
		["inside a text block: the note's second line", "the blockers of", 0],
		["sections: the loop to Away", "Away", 2],
		["sections: Burn mode to the Goal", "Goal", 2],
		["sections: the Goal to Repos", "Repos", 2],
	])("sets the rows above %s", (_, text, blanks) => {
		expect(blankRunBefore(rows, text)).toBe(blanks);
	});
});

describe("the frame's controls", () => {
	const Dcs = `${ESC}P`;
	const repos = [{ name: "wc", root: "/h/wc", ticked: true, disabled: null }];
	const rows = rowsOf({ status: { ...RUNNING, repos } });
	const Tall = 60;
	const imagesOf = (frame: string) => frame.split(Dcs).length - 1;
	const controls = rows.filter((r) => r.control?.state);

	it("keeps the text controls where images are not on", () => {
		const frame = buildFrame(rows, 80, Tall);
		expect(frame).not.toContain(Dcs);
		expect(frame).toContain("[on]");
		expect(frame).toContain("[✓]");
	});

	it("draws every control as an image, its mark gone and its cells blank", () => {
		const frame = buildFrame(rows, 80, Tall, { images: true });
		expect(imagesOf(frame)).toBe(controls.length);
		expect(frame).not.toContain("[on]");
		expect(frame).not.toContain("[✓]");
		expect(frame).toContain("Refill loop      ");
		expect(frame).toContain(`${ESC}[${SWITCH_ROW};16H${Dcs}`);
	});

	it("draws text under the images first, and holds the frame until whole", () => {
		const frame = buildFrame(rows, 80, Tall, { images: true });
		expect(frame.startsWith(`${ESC}[?2026h`)).toBe(true);
		expect(frame.endsWith(`${ESC}[?2026l`)).toBe(true);
		expect(frame.indexOf(`${ESC}[J`)).toBeLessThan(frame.indexOf(Dcs));
	});

	it("keeps the text control on the pane's last row, where an image would scroll", () => {
		const repoRow =
			SWITCH_ROW + rows.findIndex((r) => r.control?.name === "wc");
		const frame = buildFrame(rows.slice(0, repoRow - 1), 80, repoRow, {
			images: true,
		});
		expect(frame).toContain("[✓]");
		expect(imagesOf(frame)).toBe(controls.length - 1);
	});

	describe("after a scroll", () => {
		const secondControl = rows.indexOf(controls[1]);
		const scrolledRow = SWITCH_ROW + secondControl - 1;

		it("draws each control's image on the row it has moved to", () => {
			const frame = buildFrame(rows, 80, rows.length, {
				images: true,
				scroll: 1,
			});
			expect(frame).toContain(`${ESC}[${scrolledRow};`);
			expect(imagesOf(frame)).toBe(controls.length - 1);
		});

		it("hovers the control on the row the pointer rests on", () => {
			expect(findHoverRow(rows, scrolledRow, rows.length, 1)).toBe(scrolledRow);
			expect(findHoverRow(rows, scrolledRow, rows.length, 0)).toBeNull();
		});
	});

	it("keeps the text control where the image would pass the row's end", () => {
		const frame = buildFrame(rows.slice(0, 1), 18, Tall, { images: true });
		expect(frame).not.toContain(Dcs);
	});

	it("grows only the hovered row's control", () => {
		const still = buildFrame(rows, 80, Tall, { images: true });
		const hovered = buildFrame(rows, 80, Tall, {
			images: true,
			hoverRow: SWITCH_ROW,
		});
		expect(hovered).not.toBe(still);
		expect(hovered.split(Dcs).slice(2)).toEqual(still.split(Dcs).slice(2));
	});

	it("hovers a row holding a control, and no other", () => {
		expect(findHoverRow(rows, SWITCH_ROW, Tall, 0)).toBe(SWITCH_ROW);
		expect(findHoverRow(rows, SWITCH_ROW + 1, Tall, 0)).toBeNull();
		expect(findHoverRow(rows, SWITCH_ROW + 999, Tall, 0)).toBeNull();
	});
});

describe("keys and focus", () => {
	const Status = {
		...RUNNING,
		mode: "normal",
		repos: [
			{ name: "a", root: "/a", ticked: true, disabled: null },
			{ name: "b", root: "/b", ticked: false, disabled: null },
			{ name: "c", root: "/c", ticked: false, disabled: "refillLoop is false" },
		],
		burnMode: { on: false, disagreeing: [], error: null },
	};
	const Walk = [
		"Refill",
		"Away",
		"Burn",
		"Goal  ",
		"No goal",
		"[✓] a",
		"[ ] b",
	];
	const Down = { name: "down" };
	const Up = { name: "up" };
	const Space = { text: " " };
	const Escape = { name: "escape" };
	const Enter = { name: "enter" };

	/* With no `held`, a press's command ends at once; so does a focus return with no `returned`. */
	async function buildCountingPanel(
		resolveTopic: unknown = noop,
		held?: Promise<void>,
		{
			status = Status,
			height = TALL,
			columns = WIDE,
			returned = focusMoved,
		}: {
			status?: object;
			height?: number;
			columns?: number;
			returned?: typeof focusMoved;
		} = {},
	) {
		const calls: string[][] = [];
		let returns = 0;
		const run = async (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "status")
				return { code: 0, stdout: JSON.stringify(status), stderr: "" };
			await held;
			return { code: 0, stdout: "", stderr: "" };
		};
		const returnFocus = () => {
			returns += 1;
			return returned();
		};
		const panel = panelOver(run, run, resolveTopic, {
			returnFocus,
			height,
			columns,
		});
		await panel.refreshStatus();
		return {
			panel,
			returns: () => returns,
			presses: () => calls.filter((argv) => argv[0] !== "status"),
		};
	}
	type Panel = Awaited<ReturnType<typeof buildCountingPanel>>["panel"];
	const pointedText = (panel: Panel) =>
		(buildRows(panel.view, AT, WIDE) as (Row & { pointed?: boolean })[])
			.filter((r) => r.pointed)
			.map((r) => r.text);
	const rowOf = (panel: Panel, start: string) =>
		SWITCH_ROW +
		buildRows(panel.view, AT, WIDE).findIndex((r: Row) =>
			r.text.startsWith(start),
		);
	async function pointAt(panel: Panel, start: string) {
		panel.takeFocus();
		for (const _ of Walk) {
			if (pointedText(panel)[0]?.startsWith(start)) return;
			await panel.pressKey(Down);
		}
		throw new Error(`never reached ${start}`);
	}

	describe("a pane too narrow for a row", () => {
		const Narrow = 24;
		const drawn = (panel: Panel) => buildRows(panel.view, AT, Narrow);
		const narrowPanel = () =>
			buildCountingPanel(noop, undefined, { columns: Narrow });

		it("presses the control showing, below a wrapped row", async () => {
			const { panel, presses } = await narrowPanel();
			const rows = drawn(panel);
			expect(rows.length).toBeGreaterThan(
				buildRows(panel.view, AT, WIDE).length,
			);
			const box = rows.findIndex((r: Row) => r.text.startsWith("Away"));
			await panel.click(SWITCH_ROW + box);
			expect(presses().flat()).toContain("--away");
		});

		it("presses a wrapped row's press from any of its rows", async () => {
			const { panel, presses } = await buildCountingPanel(noop, undefined, {
				columns: Narrow,
				status: STOPPED,
			});
			const isPress = (r: Row & { presses?: string }) => r.presses === "loop";
			const rows = drawn(panel);
			expect(rows.filter(isPress).length).toBeGreaterThan(1);
			await panel.click(SWITCH_ROW + rows.findLastIndex(isPress));
			expect(presses().flat()).toContain("--resume");
		});

		it("moves the pointer once over a control wrapped onto two rows", async () => {
			const goal = {
				form: "topic",
				text: "a goal far too long to sit on one row of this pane",
				refs: [],
				setAt: AT,
				open: 1,
				takeable: 0,
				running: 0,
				doneAt: null,
			};
			const { panel } = await buildCountingPanel(noop, undefined, {
				columns: Narrow,
				status: { ...Status, goal },
			});
			await pointAt(panel, "Goal");
			await panel.pressKey(Down);
			const pointed = drawn(panel).filter(
				(r: Row & { pointed?: boolean }) => r.pointed,
			);
			expect(pointed).toHaveLength(1);
			await panel.pressKey(Down);
			expect(pointedText(panel)[0]).toMatch(/^\[/);
		});
	});

	describe("a pane shorter than the rows", () => {
		/* Ends on Burn mode's row, which the mark below takes; the boxes lie well below it. */
		const Short = BURN_ROW;
		const Columns = 60;
		const shortPanel = () =>
			buildCountingPanel(noop, undefined, { height: Short });
		const frameOf = (panel: Panel) =>
			buildFrame(buildRows(panel.view, AT, WIDE), Columns, Short, {
				scroll: panel.view.scroll,
			});
		/* Where the frame draws a row's text, as a mouse report counts it. */
		const drawnRowOf = (frame: string, text: string) => {
			const before = frame.slice(0, frame.indexOf(text));
			return Number(
				before
					.match(/\[(\d+);3H/g)
					?.at(-1)
					?.match(/\d+/)?.[0],
			);
		};
		const toBottom = (panel: Panel) => panel.scrollBy(99);

		it("brings the last box into view on the wheel", async () => {
			const { panel } = await shortPanel();
			expect(frameOf(panel)).not.toContain("[ ] b");
			toBottom(panel);
			expect(frameOf(panel)).toContain("[ ] b");
		});

		it("presses the row showing on a click after scrolling", async () => {
			const { panel, presses } = await shortPanel();
			toBottom(panel);
			await panel.click(drawnRowOf(frameOf(panel), "[ ] b"));
			expect(presses()).toEqual([["set", "--tick", "b", "--json"]]);
		});

		it("presses nothing on the row above the first drawn with nothing above it", async () => {
			const { panel, presses } = await shortPanel();
			await panel.click(SWITCH_ROW - 1);
			expect(presses()).toEqual([]);
			expect(panel.view.scroll).toBe(0);
		});

		it("scrolls, pressing nothing, on a click on either mark", async () => {
			const { panel, presses } = await shortPanel();
			await panel.click(Short);
			expect(panel.view.scroll).toBeGreaterThan(0);
			await panel.click(SWITCH_ROW - 1);
			expect(panel.view.scroll).toBe(0);
			expect(presses()).toEqual([]);
		});

		it("keeps a typed goal open through a click on a mark", async () => {
			const { panel } = await shortPanel();
			panel.scrollBy(2);
			await panel.click(drawnRowOf(frameOf(panel), "No goal"));
			await panel.click(Short);
			expect(panel.view.goalEdit).not.toBeNull();
		});

		it("stops at each end, the last row on the pane's last line", async () => {
			const { panel } = await shortPanel();
			panel.scrollBy(-1);
			expect(frameOf(panel)).toContain("Refill loop");
			toBottom(panel);
			const last = buildRows(panel.view, AT, WIDE).at(-1).text;
			expect(drawnRowOf(frameOf(panel), last)).toBe(Short);
			panel.scrollBy(-99);
			expect(frameOf(panel)).toContain("Refill loop");
		});

		it("draws from a kept scroll only as far as the rows now reach", async () => {
			const { panel } = await shortPanel();
			toBottom(panel);
			const fewer = buildRows(panel.view, AT, WIDE).slice(0, Short - 1);
			const frame = buildFrame(fewer, Columns, Short, {
				scroll: panel.view.scroll,
			});
			expect(frame).toContain("Refill loop");
		});

		it("marks the way more rows lie, on neither where all fit", async () => {
			const { panel } = await shortPanel();
			const marks = () => [
				frameOf(panel).includes("↑ more"),
				frameOf(panel).includes("↓ more"),
			];
			expect(marks()).toEqual([false, true]);
			panel.scrollBy(1);
			expect(marks()).toEqual([true, true]);
			toBottom(panel);
			expect(marks()).toEqual([true, false]);
			const all = buildFrame(buildRows(panel.view, AT, WIDE), Columns, TALL);
			expect(all).not.toMatch(/[↑↓] more/);
		});

		it("rubs out the mark above once back at the top", async () => {
			const { panel } = await shortPanel();
			expect(frameOf(panel)).toContain(`${ESC}[1;3H`);
			expect(frameOf(panel)).not.toContain("↑ more");
		});

		it("takes the key hint along on reaching the last control", async () => {
			const { panel } = await shortPanel();
			panel.takeFocus();
			for (const _ of Walk) await panel.pressKey(Down);
			expect(frameOf(panel)).toContain("Esc leave");
		});

		it("parks a control walked down to clear of the pane's last row", async () => {
			const { panel } = await shortPanel();
			await pointAt(panel, "Goal  ");
			expect(drawnRowOf(frameOf(panel), "Goal  ")).toBeLessThan(Short);
		});

		it("walks the pointer to the last box, bringing it into view", async () => {
			const { panel, presses } = await shortPanel();
			panel.takeFocus();
			for (const _ of Walk) await panel.pressKey(Down);
			expect(pointedText(panel)[0]).toMatch(/b$/);
			expect(frameOf(panel)).toContain("❯");
			await panel.pressKey(Space);
			expect(presses()).toEqual([["set", "--tick", "b", "--json"]]);
		});

		it("brings the pointer's control back on space, pressing nothing", async () => {
			const { panel, presses } = await shortPanel();
			panel.takeFocus();
			toBottom(panel);
			expect(frameOf(panel)).not.toContain("❯");
			await panel.pressKey(Space);
			expect(presses()).toEqual([]);
			expect(frameOf(panel)).toContain("❯");
		});

		/* Scrolled so the field shows above the mark, opened, then scrolled off the top end. */
		const fieldScrolledOff = async () => {
			const counted = await shortPanel();
			const { panel } = counted;
			panel.scrollBy(2);
			await panel.click(drawnRowOf(frameOf(panel), "No goal"));
			expect(frameOf(panel)).toContain(`${ESC}[?25h`);
			panel.scrollBy(-99);
			expect(frameOf(panel)).not.toContain(`${ESC}[?25h`);
			return counted;
		};

		it("brings the field back on Enter rather than save it unseen", async () => {
			const { panel, presses } = await fieldScrolledOff();
			await panel.pressKey(Enter);
			expect(presses()).toEqual([]);
			expect(panel.view.goalEdit).not.toBeNull();
			expect(frameOf(panel)).toContain(`${ESC}[?25h`);
		});

		it("brings the field back on a key typed after scrolling away", async () => {
			const { panel } = await fieldScrolledOff();
			await panel.pressKey({ text: "x" });
			expect(frameOf(panel)).toContain(`${ESC}[?25h`);
		});

		it("brings Save into view when a topic's issues arrive, and Enter then saves", async () => {
			const found = {
				issues: [{ repo: "a", number: 5, title: "Speed the suite" }],
				dropped: 0,
			};
			const { panel, presses } = await buildCountingPanel(
				async () => found,
				undefined,
				{ height: Short },
			);
			panel.scrollBy(2);
			await panel.click(drawnRowOf(frameOf(panel), "No goal"));
			await panel.pressKey({ text: "speed" });
			await panel.pressKey(Enter);
			expect(frameOf(panel)).toContain("Save this one");
			await panel.pressKey(Enter);
			expect(presses().flat()).toContain("--goal-text=speed");
		});
	});

	describe("the pointer", () => {
		it("moves through every control, skipping a disabled box, and stops at each end", async () => {
			const { panel } = await buildCountingPanel();
			panel.takeFocus();
			const walked = [pointedText(panel)[0]];
			for (const _ of Walk) {
				await panel.pressKey(Down);
				walked.push(pointedText(panel)[0]);
			}
			expect(
				walked
					.slice(0, Walk.length)
					.map((t, i) => t?.startsWith(Walk[i] ?? "")),
			).toEqual(Walk.map(() => true));
			expect(walked.at(-1)).toBe(walked.at(-2));
			await panel.pressKey(Up);
			expect(pointedText(panel)[0]).toMatch(/a$/);
			for (const _ of Walk) await panel.pressKey(Up);
			expect(pointedText(panel)[0]).toMatch(/^Refill/);
		});

		it("marks no row while a field is open, as the arrows do not move then", async () => {
			const { panel } = await buildCountingPanel();
			panel.takeFocus();
			await panel.click(rowOf(panel, "No goal"));
			expect(pointedText(panel)).toEqual([]);
		});

		it("shows on the first arrow where the terminal reports no focus", async () => {
			const { panel } = await buildCountingPanel();
			expect(pointedText(panel)).toEqual([]);
			await panel.pressKey(Down);
			expect(pointedText(panel)[0]).toMatch(/^Refill/);
		});

		it("draws in the column left of the rows, and erases when it moves off", async () => {
			const { panel } = await buildCountingPanel();
			panel.takeFocus();
			const frame = () => buildFrame(buildRows(panel.view, AT, WIDE), 60, 50);
			expect(frame()).toContain(`${ESC}[${SWITCH_ROW};1H❯`);
			await panel.pressKey(Down);
			expect(frame()).toContain(`${ESC}[${SWITCH_ROW};1H `);
			expect(frame().match(/❯/g)).toHaveLength(1);
		});

		it("lists the hint under the last control, and drops it while typing", async () => {
			const { panel } = await buildCountingPanel();
			const last = () => buildRows(panel.view, AT, WIDE).at(-1)?.text;
			const hint = "Esc leave";
			expect(last()).toBe(hint);
			await panel.click(rowOf(panel, "No goal"));
			expect(last()).not.toBe(hint);
		});
	});

	describe("space", () => {
		it.each([
			["Refill", ["set", "--pause", "--json"]],
			["Away", ["set", "--away", "--json"]],
			["[ ] b", ["set", "--tick", "b", "--json"]],
			["Burn", ["on"]],
		])("on %s runs what a click runs", async (start, argv) => {
			const clicked = await buildCountingPanel();
			await clicked.panel.click(rowOf(clicked.panel, start));
			const keyed = await buildCountingPanel();
			await pointAt(keyed.panel, start);
			await keyed.panel.pressKey(Space);
			expect(keyed.presses()).toEqual(clicked.presses());
			expect(keyed.presses()).toEqual([argv]);
		});

		it("on a set goal's switch runs what a click runs", async () => {
			const status = {
				...Status,
				goal: {
					form: "issues",
					text: "#5",
					set: [],
					open: 1,
					takeable: 1,
					running: 0,
					doneAt: null,
					readAt: AT,
				},
			};
			const clicked = await buildCountingPanel(noop, undefined, { status });
			await clicked.panel.click(rowOf(clicked.panel, "Goal  "));
			const keyed = await buildCountingPanel(noop, undefined, { status });
			await pointAt(keyed.panel, "Goal  ");
			await keyed.panel.pressKey(Space);
			expect(keyed.presses()).toEqual(clicked.presses());
			expect(keyed.presses()).toEqual([["set", "--clear-goal", "--json"]]);
		});

		it("keeps focus, for the next control", async () => {
			const { panel, returns } = await buildCountingPanel();
			await pointAt(panel, "Away");
			await panel.pressKey(Space);
			expect(returns()).toBe(0);
			expect(pointedText(panel)[0]).toMatch(/^Away/);
		});

		it("on the goal text opens the field, whose keys then type", async () => {
			const { panel, returns } = await buildCountingPanel();
			await pointAt(panel, "No goal");
			await panel.pressKey(Space);
			await panel.pressKey(Space);
			expect(panel.view.goalEdit?.text).toBe(" ");
			expect(returns()).toBe(0);
		});

		it.each([
			["with no pointer", false, Space],
			["pasted", true, { text: " ", pasted: true }],
			["twice in one read", true, { text: "  " }],
		])("does nothing %s", async (_label, pointed, pressed) => {
			const { panel, presses } = await buildCountingPanel();
			if (pointed) panel.takeFocus();
			await panel.pressKey(pressed);
			expect(presses()).toEqual([]);
		});
	});

	describe("a stray key", () => {
		it.each([
			["a letter", { text: "p" }],
			["Enter", Enter],
			["a left arrow", { name: "left" }],
			["backspace", { name: "backspace" }],
		])("%s changes nothing, on any control", async (_label, pressed) => {
			const { panel, presses, returns } = await buildCountingPanel();
			panel.takeFocus();
			for (const _step of Walk) {
				await panel.pressKey(pressed);
				await panel.pressKey(Down);
			}
			expect(presses()).toEqual([]);
			expect(returns()).toBe(0);
			expect(panel.view.goalEdit).toBeNull();
		});
	});

	describe("Esc", () => {
		it("leaves: the pointer goes, focus returns and nothing runs", async () => {
			const { panel, presses, returns } = await buildCountingPanel();
			panel.takeFocus();
			await panel.pressKey(Escape);
			expect(pointedText(panel)).toEqual([]);
			expect(returns()).toBe(1);
			expect(presses()).toEqual([]);
		});
	});

	describe("a click", () => {
		it("returns focus before its command ends", async () => {
			const { held, release } = heldUntil();
			const { panel, returns } = await buildCountingPanel(noop, held);
			const clicking = panel.click(rowOf(panel, "Away"));
			expect(returns()).toBe(1);
			release();
			await clicking;
			expect(returns()).toBe(1);
		});

		it("returns focus off any control, so the focusing click cannot trap it", async () => {
			const { panel, presses, returns } = await buildCountingPanel();
			await panel.click(SWITCH_ROW + 1);
			expect(returns()).toBe(1);
			expect(presses()).toEqual([]);
		});

		it("on the goal text keeps focus while typing, and clicking away gives it back", async () => {
			const { panel, returns } = await buildCountingPanel();
			await panel.click(rowOf(panel, "No goal"));
			await panel.pressKey({ text: "#5" });
			expect(panel.view.goalEdit?.text).toBe("#5");
			expect(returns()).toBe(0);
			await panel.click(SWITCH_ROW + 1);
			expect(returns()).toBe(1);
		});
	});

	describe("handing focus back", () => {
		it("returns once for two presses while the first return runs", async () => {
			const { held, release } = heldUntil();
			const { panel, returns } = await buildCountingPanel(noop, undefined, {
				returned: async () => {
					await held;
					return { code: 0, stdout: "", stderr: "" };
				},
			});
			const first = panel.pressKey(Escape);
			const second = panel.pressKey(Escape);
			release();
			await Promise.all([first, second]);
			expect(returns()).toBe(1);
		});

		it("does not return where a focus report says the founder has gone", async () => {
			const { panel, returns } = await buildCountingPanel();
			panel.takeFocus();
			panel.loseFocus();
			await panel.pressKey(Escape);
			expect(returns()).toBe(0);
		});

		it("shows why and keeps the pointer where the return fails", async () => {
			const { panel } = await buildCountingPanel(noop, undefined, {
				returned: async () => ({ code: 1, stdout: "", stderr: "no wt.exe" }),
			});
			panel.takeFocus();
			await panel.pressKey(Escape);
			const texts = buildRows(panel.view, AT, WIDE).map((r: Row) => r.text);
			expect(texts).toContain("Focus stayed here: no wt.exe");
			expect(pointedText(panel)[0]).toMatch(/^Refill/);
		});

		it("clears that once a return works", async () => {
			let code = 1;
			const { panel } = await buildCountingPanel(noop, undefined, {
				returned: async () => ({ code, stdout: "", stderr: "no wt.exe" }),
			});
			await panel.pressKey(Escape);
			code = 0;
			await panel.pressKey(Escape);
			expect(panel.view.focusNote).toBeNull();
		});

		it("leaves on a miss, pressing nothing, but not while typing", async () => {
			const { panel, presses, returns } = await buildCountingPanel();
			await panel.missClick();
			expect(returns()).toBe(1);
			await panel.click(rowOf(panel, "No goal"));
			await panel.missClick();
			expect(returns()).toBe(1);
			expect(presses()).toEqual([]);
		});
	});

	describe("the goal field", () => {
		async function typing(text: string, resolveTopic: unknown = noop) {
			const open = await buildCountingPanel(resolveTopic);
			await open.panel.click(rowOf(open.panel, "No goal"));
			await open.panel.pressKey({ text });
			return open;
		}

		it("gives focus back on Enter, as the goal goes off", async () => {
			const { panel, presses, returns } = await typing("#5");
			await panel.pressKey(Enter);
			expect(returns()).toBe(1);
			expect(presses()).toEqual([["set", "--goal=#5", "--json"]]);
		});

		it("gives focus back on Esc, saving nothing", async () => {
			const { panel, presses, returns } = await typing("#5");
			await panel.pressKey(Escape);
			expect(returns()).toBe(1);
			expect(presses()).toEqual([]);
		});

		it("gives focus back on a blank Enter", async () => {
			const { panel, returns } = await typing("  ");
			await panel.pressKey(Enter);
			expect(returns()).toBe(1);
		});

		it("holds focus through a topic to its save", async () => {
			const found = async () => ({
				issues: [{ repo: "a", number: 5, title: "Speed" }],
				dropped: 0,
			});
			const { panel, presses, returns } = await typing("make it fast", found);
			await panel.pressKey(Enter);
			expect(returns()).toBe(0);
			await panel.pressKey(Enter);
			expect(returns()).toBe(1);
			expect(presses()[0]?.[1]).toBe("--goal-issues=a#5");
		});

		it("gives focus back on a click elsewhere, the topic staying open", async () => {
			const found = async () => ({
				issues: [{ repo: "a", number: 5, title: "Speed" }],
				dropped: 0,
			});
			const { panel, returns } = await typing("make it fast", found);
			await panel.pressKey(Enter);
			expect(returns()).toBe(0);
			await panel.click(rowOf(panel, "Away"));
			expect(returns()).toBe(1);
			expect(panel.view.goalResolve?.found).not.toBeNull();
		});

		it("does not pull focus back when a resolve fails after the founder left", async () => {
			const { held, release } = heldUntil();
			const answer = async () => {
				await held;
				return { why: "no reply" };
			};
			const { panel, returns } = await typing("make it fast", answer);
			const saving = panel.pressKey(Enter);
			panel.loseFocus();
			release();
			await saving;
			expect(returns()).toBe(0);
			expect(panel.view.goalResolve).toBeNull();
		});

		it("gives focus back on a topic's Esc", async () => {
			const found = async () => ({ issues: [], dropped: 0 });
			const { panel, returns } = await typing("make it fast", found);
			await panel.pressKey(Enter);
			await panel.pressKey(Escape);
			expect(returns()).toBe(1);
		});

		it("takes no Enter while a topic resolves, so focus waits on the answer", async () => {
			const { held, release } = heldUntil();
			const answer = async () => {
				await held;
				return { why: "no reply" };
			};
			const { panel, returns } = await typing("make it fast", answer);
			const saving = panel.pressKey(Enter);
			await panel.pressKey(Enter);
			expect(returns()).toBe(0);
			release();
			await saving;
			expect(returns()).toBe(1);
			expect(panel.view.goalResolve).toBeNull();
		});
	});
});
