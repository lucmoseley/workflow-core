/*
 * The panel's view and press mapping (#3873, #3875, #3877, #3879, #3881, #3883, #3884). Built on the view so every loop state costs one literal rather than a terminal.
 * Broken, the panel reads a press as done, or a stopped loop as on.
 */
import { describe, expect, it, vi } from "vitest";

const {
	ESC,
	buildFrame,
	findHoverRow,
	buildRows,
	createPanel,
} = require("./refill-panel.js");

const AT = new Date(2026, 10, 2, 14, 5).getTime();
const LATER = AT + 60_000;

const BURN_OFF = { on: false, disagreeing: [], error: null };
const BURN_ON = { on: true, disagreeing: [], error: null };
const planSeats = (week: number | null, weekFull = false) => ({
	readings: [
		{ seat: "~/.claude3", week: 47, weekFull: false },
		{ seat: "~/.claude2", week, weekFull },
	],
});
const FULL_SEATS = {
	readings: [
		{ seat: "~/.claude3", week: 100, weekFull: true },
		{ seat: "~/.claude2", week: 100, weekFull: true },
	],
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
	mode: "normal",
	handedOffSinceAway: 0,
	repos: [],
	goal: null,
	seats: planSeats(80),
	overflow: [],
	burnMode: BURN_OFF,
};
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
	headroomUsd: 258.5,
	exhausted: false,
	noLaunchLeft: false,
	...over,
});
const STOPPING = { ...RUNNING, stopRequested: true };

/* The block's top row, as a mouse report counts it. */
const SWITCH_ROW = 2;
/* Below the switch, a row, its three lines and two rows clear: the settings. */
const AWAY_ROW = 9;
const AWAY_INDEX = AWAY_ROW - SWITCH_ROW;
/* One sibling row below Away (#3596 story 78). */
const BURN_ROW = 11;
const BURN_INDEX = BURN_ROW - SWITCH_ROW;
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
	pending: null,
	refusal: null,
	awayPending: null,
	awayNote: null,
	burnPending: null,
	burnReport: null,
	goalEdit: null,
	goalPending: null,
	goalNote: null,
	repoPending: {},
	repoRefusal: null,
	...over,
});
const rowsOf = (over: object): Row[] => buildRows(view(over), LATER);
const summary = (rows: Row[]) => rows.map((r) => [r.text, r.role]);
/* The rows of one section: to the blank row that ends it. */
const toGap = (rows: Row[]) => {
	const end = rows.findIndex((r) => r.text === "");
	return end === -1 ? rows : rows.slice(0, end);
};
const panelOver = (
	run: unknown,
	runBurn: unknown = run,
	resolveTopic: unknown = noop,
) => createPanel({ run, runBurn, now: () => AT, resolveTopic, onChange: noop });

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
	it("shows a running loop", () => {
		const rows = rowsOf({ status: RUNNING });
		expect(summary(rows).slice(0, 5)).toEqual([
			["Refill loop  [on]", "name"],
			["", "secondary"],
			["3 launched today", "value"],
			["Waiting: no free slot", "secondary"],
			["Plans this week: .claude3 47%, .claude2 80%", "secondary"],
		]);
		expect(rows[0].control?.state).toBe("on");
	});

	it("waits on the next check after a tick that launched", () => {
		const lastTick = {
			at: AT,
			summary: "launched 2",
			idle: null,
			paused: false,
		};
		expect(rowsOf({ status: { ...RUNNING, lastTick } })[3].text).toBe(
			"Waiting: the next check",
		);
	});

	it("never shows a lifted pause's words beside a switch reading on", () => {
		const rows = rowsOf({ status: { ...RUNNING, lastTick: PAUSED_TICK } });
		expect(summary(rows).slice(0, 5)).toEqual([
			["Refill loop  [on]", "name"],
			["", "secondary"],
			["3 launched today", "value"],
			["Waiting: the next check", "secondary"],
			["Plans this week: .claude3 47%, .claude2 80%", "secondary"],
		]);
	});

	it("shows a press to turn off, never reading as done", () => {
		const rows = rowsOf({
			status: RUNNING,
			pending: { on: false, landed: false },
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
			pending: { on: true, landed: false },
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

	it("is the switch and three lines in every case", () => {
		const cases = [
			{},
			{ readError: "x" },
			{ status: RUNNING },
			{ status: { ...RUNNING, lastTick: null } },
			{ status: { ...RUNNING, seats: { readings: [] } } },
			{ status: CRASHED },
			{ status: STALLED },
			{ status: NEVER_STARTED },
			{
				status: { ...RUNNING, seats: FULL_SEATS, overflow: [key()] },
			},
			{ status: PAUSED_BY_FOUNDER },
			{ status: { ...PAUSED_BY_FOUNDER, running: false } },
			{ status: STOPPED },
			{ status: STOPPING },
			{ status: RUNNING, pending: { on: false, landed: true } },
			{ status: PAUSED_BY_FOUNDER, pending: { on: true, landed: false } },
			{ status: RUNNING, refusal: { text: "refused", at: LATER } },
		];
		for (const c of cases)
			expect(rowsOf(c)[BURN_INDEX].text).toMatch(/^Burn mode/);
	});
});

describe("the spend line", () => {
	const line3 = (status: object) => rowsOf({ status })[4];

	it("shows each plan seat's week in grey, unread where it will not read", () => {
		const row = line3({ ...RUNNING, seats: planSeats(null) });
		expect(row.text).toBe("Plans this week: .claude3 47%, .claude2 unread");
		expect(row.role).toBe("secondary");
	});

	it("shows nothing about credits with no key declared, every plan full", () => {
		const rows = rowsOf({ status: { ...RUNNING, seats: FULL_SEATS } });
		expect(rows[4].text).toBe("Plans this week: .claude3 100%, .claude2 100%");
		expect(rows[0].detail).toBeUndefined();
	});

	it("shows nothing about credits while a plan has room, a key declared", () => {
		const rows = rowsOf({ status: { ...RUNNING, overflow: [key()] } });
		expect(rows[4].text).toMatch(/^Plans this week/);
		expect(rows[0].detail).toBeUndefined();
	});

	it("shows credits left in white, every key summed, and says so by the switch", () => {
		const overflow = [
			key(),
			key({ headroomUsd: 100, grantUsd: 200 }),
			key({
				noLaunchLeft: true,
				exhausted: true,
				headroomUsd: 0,
				grantUsd: 100,
			}),
		];
		const rows = rowsOf({
			status: { ...RUNNING, seats: FULL_SEATS, overflow },
		});
		expect(rows[4].text).toBe("On API credits: $358 of $700 left");
		expect(rows[4].role).toBe("value");
		expect(rows[0].detail).toBe("API credits · on");
	});

	it("draws the words by the switch outside its bold", () => {
		const status = { ...RUNNING, seats: FULL_SEATS, overflow: [key()] };
		const frame = buildFrame(rowsOf({ status }), 80, 40);
		expect(frame).toContain(`Refill loop  [on]${ESC}[22m  API credits · on`);
	});

	it("says all used up once every key is spent, the switch staying on", () => {
		const status = {
			...RUNNING,
			seats: FULL_SEATS,
			overflow: [key({ noLaunchLeft: true }), key({ noLaunchLeft: true })],
			lastTick: planWaitTick(AT),
		};
		const rows = rowsOf({ status });
		expect(rows[4].text).toBe("Plans and API credits all used up");
		expect(rows[0].control?.state).toBe("on");
		expect(rows[0].detail).toBeUndefined();
	});

	it("never calls credits used up with a key unread", () => {
		const overflow = [
			key({ noLaunchLeft: true }),
			{ seat: "k", why: "no table" },
		];
		const row = line3({ ...RUNNING, seats: FULL_SEATS, overflow });
		expect(row.text).toBe("API credits unread: no table");
		expect(row.role).toBe("secondary");
	});

	it("sums what reads and says a key is unread, with credits live", () => {
		const overflow = [key(), { seat: "k", why: "no table" }];
		const row = line3({ ...RUNNING, seats: FULL_SEATS, overflow });
		expect(row.text).toBe("On API credits: $258 of $400 left, a key unread");
		expect(row.role).toBe("value");
	});

	it("counts a key reserved past its grant as nothing left, never less", () => {
		const overflow = [key({ headroomUsd: -11 }), key({ headroomUsd: 10 })];
		const row = line3({ ...RUNNING, seats: FULL_SEATS, overflow });
		expect(row.text).toBe("On API credits: $10 of $800 left");
	});

	it("says nothing beside a switch that is not on", () => {
		const paused = {
			...PAUSED_BY_FOUNDER,
			seats: FULL_SEATS,
			overflow: [key()],
		};
		expect(rowsOf({ status: paused })[0].detail).toBeUndefined();
		const running = { ...RUNNING, seats: FULL_SEATS, overflow: [key()] };
		expect(
			rowsOf({ status: running, pending: { on: false, landed: false } })[0]
				.detail,
		).toBeUndefined();
	});

	it("stays on line 3 through a pending press", () => {
		const rows = rowsOf({
			status: RUNNING,
			pending: { on: false, landed: false },
		});
		expect(rows[4].text).toMatch(/^Plans this week/);
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
		expect(frame).toContain(`${ESC}[38;2;242;242;242m3 launched today`);
		expect(frame).toContain(`${ESC}[38;2;148;148;148mWaiting: no free slot`);
	});

	it("uses no blue in any colour it draws", () => {
		const all = frame + buildFrame(rowsOf({ status: CRASHED }), 80, 40);
		for (const [, r, g, b] of all.matchAll(/38;2;(\d+);(\d+);(\d+)m/g))
			expect(Number(b)).toBeLessThanOrEqual(Math.max(Number(r), Number(g)));
	});
});

describe("the panel's frame", () => {
	it("cuts a long row rather than wrapping it into the next", () => {
		const long = {
			...RUNNING,
			lastTick: { at: AT, summary: "", idle: "x".repeat(99), paused: false },
		};
		const frame = buildFrame(rowsOf({ status: long }), 20, 40);
		expect(frame).toContain("Waiting: xxxxxx…");
		expect(frame).not.toContain("x".repeat(20));
	});

	it("erases below its last row, so a report gone from the rows goes from the screen", () => {
		const frame = buildFrame(rowsOf({ status: RUNNING }), 80, 40);
		expect(frame.endsWith(`${ESC}[J`)).toBe(true);
	});

	it("draws no control character a command printed", () => {
		const refusal = { text: `bad${ESC}[31m\nthing`, at: LATER };
		const frame = buildFrame(rowsOf({ status: RUNNING, refusal }), 80, 40);
		expect(frame).toContain("bad [31m thing");
	});
});

describe("a click on the switch", () => {
	it("pauses a running loop through `set --pause`", async () => {
		const { calls, run } = runnerOf({
			"set --pause": () => ({}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls[1]).toEqual(["set", "--pause"]);
	});

	it("resumes a paused loop through `set --resume`", async () => {
		const { calls, run } = runnerOf({
			"set --resume": () => ({}),
			"status --json": showing(PAUSED_BY_FOUNDER),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls[1]).toEqual(["set", "--resume"]);
	});

	it.each([
		["crashed", CRASHED],
		["stopped", STOPPED],
		["paused, its process dead", { ...STALLED, running: false, crashed: true }],
	])("restarts a %s loop through `set --resume`", async (_name, status) => {
		const { calls, run } = runnerOf({
			"status --json": showing(status),
			"set --resume": () => ({}),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(calls).toContainEqual(["set", "--resume"]);
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
				"set --resume": () => ({}),
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
			"set --resume": () => ({}),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(panel.view.pending?.on).toBe(true);
		status = RUNNING;
		await panel.refreshStatus();
		expect(panel.view.pending).toBeNull();
	});

	it("gives the row back where the restarted process never shows", async () => {
		const { run } = runnerOf({
			"status --json": showing(CRASHED),
			"set --resume": () => ({}),
		});
		let at = AT;
		const panel = createPanel({
			run,
			runBurn: run,
			now: () => at,
			onChange: noop,
		});
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		at += 29_000;
		await panel.refreshStatus();
		expect(panel.view.pending?.on).toBe(true);
		at += 1000;
		await panel.refreshStatus();
		expect(panel.view.pending).toBeNull();
		expect(buildRows(panel.view, at)[2].text).toBe("needs you");
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
				"set --pause": () => ({}),
				"set --resume": () => ({}),
				"set --away": () => ({}),
				on: () => ({}),
				off: () => ({}),
			});
			const panel = panelOver(run);
			await panel.refreshStatus();
			const rows = buildRows(panel.view, AT).length;
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
		expect(buildRows(panel.view, LATER)[2].text).toBe("turning off…");
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
	async function pressed(before: object, after: object, press = "set --pause") {
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
		expect(panel.view.pending).not.toBeNull();
		expect(buildRows(panel.view, LATER)[3].text).toBe(
			"Turning off when this check ends",
		);
	});

	it("clears once a tick has started since the pause", async () => {
		const { panel, show } = await pressed(RUNNING, PAUSED_MID_TICK);
		await show({ ...PAUSED_MID_TICK, lastTick: PAUSED_TICK });
		expect(panel.view.pending).toBeNull();
		expect(buildRows(panel.view, LATER)[2].text).toBe(
			"You switched it off at 14:06",
		);
	});

	it("clears at once where no process runs to take the pause", async () => {
		const { panel } = await pressed(RUNNING, {
			...PAUSED_MID_TICK,
			running: false,
		});
		expect(panel.view.pending).toBeNull();
	});

	it("clears on a read showing a resume", async () => {
		const { panel } = await pressed(
			PAUSED_BY_FOUNDER,
			{ ...RUNNING, lastTick: PAUSED_TICK },
			"set --resume",
		);
		expect(panel.view.pending).toBeNull();
		const rows = buildRows(panel.view, LATER);
		expect(rows[0].control.state).toBe("on");
		expect(rows[3].text).toBe("Waiting: the next check");
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
		expect(panel.view.pending).not.toBeNull();
		release();
		await clicked;
		expect(panel.view.pending).toBeNull();
	});

	it("clears where another writer has since reversed the press", async () => {
		const { panel } = await pressed(RUNNING, RUNNING);
		expect(panel.view.pending).toBeNull();
	});

	it("clears on the command's refusal and shows it, then gives line 2 back", async () => {
		const { run } = runnerOf({
			"set --pause": () => ({
				code: 1,
				stderr: "refill loop: nothing set: the control is damaged\n",
			}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
		expect(panel.view.pending).toBeNull();
		const rows = buildRows(panel.view, AT + 1);
		expect(rows[0].control.state).toBe("on");
		expect(rows[3].text).toBe(
			"refill loop: nothing set: the control is damaged",
		);
		expect(buildRows(panel.view, LATER)[3].text).toBe("Waiting: no free slot");
	});

	it("survives an unreadable status, and claims nothing during it", async () => {
		const { panel, show } = await pressed(RUNNING, PAUSED_MID_TICK);
		await show({ nonsense: true });
		expect(panel.view.pending).not.toBeNull();
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
		const [title, gap, ...below] = rows.slice(BURN_INDEX);
		return gap.text === "" && below[0]?.text !== ""
			? [title, ...toGap(below)]
			: [title];
	};
	const burnRowsOf = (over: object) => burnSection(rowsOf(over));
	const burnRows = (panel: { view: object }): Row[] =>
		burnSection(buildRows(panel.view, LATER));
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
		expect(panel.view.pending).toBeNull();
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
		expect(panel.view.burnPending).not.toBeNull();
		await panel.click(BURN_ROW);
		expect(flips).toHaveLength(1);
		release();
		await clicked;
		expect(panel.view.burnPending).toBeNull();
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
		expect(panel.view.burnPending).toBeNull();
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
	const awayRowsOf = (over: object) =>
		rowsOf(over).slice(AWAY_INDEX, BURN_INDEX);

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
			awayPending: { on: false, landed: false },
		});
		expect(turningOff.text).toBe("Away  […]  turning off…");
		expect(turningOff.control?.state).toBe("pending");
		const [turningOn] = awayRowsOf({
			status: RUNNING,
			awayPending: { on: true, landed: false },
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
			{ status: Away, awayPending: { on: false, landed: false } },
			{ status: RUNNING, awayNote: { text: "refused", at: LATER } },
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
		const { calls, panel } = await clicked(RUNNING, "set --away", Away);
		expect(calls).toContainEqual(["set", "--away"]);
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].text).toBe("Away  [on]");
	});

	it("turns away off through `set --normal`", async () => {
		const { calls, panel } = await clicked(Away, "set --normal", RUNNING);
		expect(calls).toContainEqual(["set", "--normal"]);
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].text).toBe(
			"Away  [off]  normal",
		);
	});

	it("works with the loop stopped or paused, either way", async () => {
		const stopped = await clicked(STOPPED, "set --away");
		expect(stopped.calls).toContainEqual(["set", "--away"]);
		const paused = await clicked(
			{ ...PAUSED_BY_FOUNDER, mode: "away" },
			"set --normal",
		);
		expect(paused.calls).toContainEqual(["set", "--normal"]);
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
			"set --away": () => ({}),
			"status --json": () => ({ stdout: JSON.stringify(shown) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].text).toBe(
			"Away  [on]  2 handed off",
		);
		shown = RUNNING;
		await panel.refreshStatus();
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].text).toBe(
			"Away  [off]  normal",
		);
		await panel.click(AWAY_ROW);
		expect(calls).toContainEqual(["set", "--away"]);
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
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].control.state).toBe(
			"pending",
		);
		await panel.refreshStatus();
		expect(panel.view.awayPending).not.toBeNull();
		await panel.click(AWAY_ROW);
		expect(calls.filter((c) => c[0] === "set")).toHaveLength(1);
		release();
		await press;
		expect(panel.view.awayPending).toBeNull();
		expect(buildRows(panel.view, LATER)[AWAY_INDEX].control.state).toBe("on");
	});

	it("clears on the command's refusal and shows it on its own row, then blanks it", async () => {
		const { run } = runnerOf({
			"set --away": () => ({
				code: 1,
				stderr: "refill loop: nothing set: busy\n",
			}),
			"status --json": showing(RUNNING),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		expect(panel.view.awayPending).toBeNull();
		const rows = buildRows(panel.view, AT);
		expect(rows[AWAY_INDEX].control.state).toBe("off");
		expect(rows[AWAY_INDEX + 1]).toMatchObject({
			text: "refill loop: nothing set: busy",
			role: "value",
		});
		expect(rows[3].text).toBe("Waiting: no free slot");
		expect(buildRows(panel.view, AT + 60_000)[AWAY_INDEX + 1].text).toBe("");
	});

	it("shows the command's warning on a loop with no process, then blanks it", async () => {
		const warning =
			"refill loop: not running; its next start sets the mode, repos and goal afresh";
		let shown: object = STOPPED;
		const { run } = runnerOf({
			"set --away": () => {
				shown = { ...STOPPED, mode: "away" };
				return { stdout: `mode:      away\n${warning}\n` };
			},
			"status --json": () => ({ stdout: JSON.stringify(shown) }),
		});
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(AWAY_ROW);
		const rows = buildRows(panel.view, AT);
		expect(rows[AWAY_INDEX].text).toBe("Away  [on]");
		expect(rows[AWAY_INDEX + 1]).toMatchObject({
			text: warning,
			role: "value",
		});
		expect(buildRows(panel.view, AT + 60_000)[AWAY_INDEX + 1].text).toBe("");
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
		const rows = buildRows(panel.view, LATER);
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
		buildRows(panel.view, LATER).findIndex(
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
		expect(texts.slice(-2)).toEqual([
			"An unticked repo still supplies",
			"the blockers of served issues",
		]);
		expect(texts.at(-3)).toBe("");
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
		const rows = buildRows(panel.view, LATER);
		expect(boxOf(rows, "design-vault")).toMatchObject({
			text: "[…] design-vault  turning on…",
			control: { state: "pending" },
		});
		expect(rows.find((r: Row) => r.text === "Repos").detail).toBe("2 of 4 on");
		await panel.refreshStatus();
		expect(
			boxOf(buildRows(panel.view, LATER), "design-vault")?.control?.state,
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
			["set", "--tick", "design-vault"],
		]);
		expect(
			boxOf(buildRows(panel.view, LATER), "design-vault")?.control?.state,
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
		expect(presses()).toEqual([["set", "--untick", "workflow-core"]]);
		expect(boxOf(buildRows(panel.view, LATER), "workflow-core")).toMatchObject({
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
		const rows = buildRows(panel.view, LATER);
		await panel.click(
			SWITCH_ROW + rows.findIndex((r: Row) => r.text === "Repos"),
		);
		await panel.click(SWITCH_ROW + rows.length - 1);
		expect(presses()).toEqual([]);
	});

	it("shows a refusal in the gap below its box, moving no box, and clears the mark", async () => {
		const { panel } = repoPanel(WithRepos, {
			code: 2,
			stderr: "design-vault: no workflow-core config\n",
		});
		await panel.refreshStatus();
		const rowsBefore = buildRows(panel.view, LATER);
		const row = rowOfBox(panel, "design-vault");
		await panel.click(row);
		const rows = buildRows(panel.view, AT);
		expect(rows).toHaveLength(rowsBefore.length);
		expect(boxOf(rows, "design-vault")?.control?.state).toBe("unticked");
		expect(rows[row - SWITCH_ROW + 1]).toEqual({
			text: "design-vault: no workflow-core config",
			role: "value",
		});
		const expired = buildRows(panel.view, AT + 10_000);
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
		SWITCH_ROW + buildRows(panel.view, AT).findIndex(test);
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
				goalPending: { on: true, landed: false },
			});
			expect(rows[0]).toMatchObject({
				text: "Goal  […]  setting…",
				control: { state: "pending" },
			});
			expect(rows[2].text).toContain("drain #2518");
			expect(
				goalRows({
					status: WithGoal,
					goalPending: { on: false, landed: false },
				})[0].text,
			).toBe("Goal  […]  turning off…");
		});
	});

	describe("its two-line caption", () => {
		const refused = {
			text: "wc#5 is in wc, which is not ticked: tick wc first",
			at: LATER,
		};
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
				{ status: WithGoal, goalPending: { on: true, landed: false } },
			],
			["a refusal", { status: WithGoal, goalNote: refused }],
			[
				"a note of one clause",
				{ status: WithGoal, goalNote: { text: "exit 1", at: LATER } },
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
				buildRows(view({ status: WithGoal, goalNote: refused }), now).map(
					(r: Row) => r.text,
				);
			expect(rows(LATER)).toContain("wc#5 is in wc, which is not ticked");
			expect(rows(LATER)).toContain("tick wc first");
			expect(rows(LATER)).not.toContain(Caption[0]);
			expect(rows(LATER + 10_000)).toContain(Caption[0]);
		});

		it("splits the warning of a loop with no process across its two rows", () => {
			const goalNote = {
				text: "refill loop: not running; this holds from its next start",
				at: LATER,
			};
			const texts = rowsOf({ status: WithGoal, goalNote }).map((r) => r.text);
			expect(texts).toContain("not running");
			expect(texts).toContain("this holds from its next start");
		});

		it("shows a refusal off the lock's read without the command's prefix", () => {
			const goalNote = {
				text: "refill loop: nothing set: #5 names no repo with 2 repos ticked: write <repo>#5",
				at: LATER,
			};
			const texts = rowsOf({ status: WithGoal, goalNote }).map((r) => r.text);
			expect(texts).toContain("#5 names no repo with 2 repos ticked");
			expect(texts).toContain("write <repo>#5");
		});
	});

	describe("the switch", () => {
		it("clears the goal, and only that", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(switchRow(panel));
			expect(presses()).toEqual([["set", "--clear-goal"]]);
		});

		it("clears a finished goal too", async () => {
			const { panel, presses } = await goalPanel(Done);
			await panel.click(switchRow(panel));
			expect(presses()).toEqual([["set", "--clear-goal"]]);
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
			pending.panel.view.goalPending = { on: true, landed: false };
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
			expect(panel.view.goalPending).toMatchObject({ on: false });
			release();
			await press;
			expect(readsDone).toBe(1);
			expect(panel.view.goalPending).toBeNull();
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
			expect(presses()).toEqual([["set", flag]]);
			expect(panel.view.goalEdit).toBeNull();
		});

		it.each(["--pause", "--help", "--", "--untick wc"])(
			"keeps typed %j to the one argument, so it reaches no other flag",
			async (typed) => {
				const { panel, presses } = await goalPanel(WithGoal, {}, Found);
				await typeGoal(panel, typed);
				await panel.pressKey(Enter);
				expect(presses()).toEqual([
					["set", "--goal-issues=wc#5,wc#7", `--goal-text=${typed}`],
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
				buildRows(panel.view, AT).map((r: { text: string }) => r.text);
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
				const rows = buildRows(panel.view, AT);
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
					["set", "--goal-issues=wc#5,wc#7", "--goal-text=clear Phase 0"],
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
				expect(panel.view.goalNote?.text).toContain("status --json: bad");
				expect(presses()).toEqual([]);
			});

			it("clears a held reason on a repo press", async () => {
				const { panel } = await goalPanel(Ticked, {}, async () => ({
					why: "no repo is ticked",
				}));
				await typeGoal(panel, "topic");
				expect(panel.view.goalNote?.held).toBe(true);
				await panel.click(rowOf(panel, "[✓] wc"));
				expect(panel.view.goalNote).toBeNull();
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
				expect(panel.view.goalNote).toBeNull();
			});

			it("shows a failure's reason past the note time, the old goal in place", async () => {
				const { panel, presses } = await goalPanel(WithGoal, {}, async () => ({
					why: "the model named no issue",
				}));
				await typeGoal(panel, "topic");
				const shown = buildRows(panel.view, AT + 3_600_000).map(
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
						stderr: "refill loop: wc#5 is closed: a goal names open issues",
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
			expect(panel.view.goalPending).toBeNull();
			expect(presses()).toEqual([]);
		});

		it("shows the new goal once a read shows it", async () => {
			const { panel, show } = await goalPanel(WithGoal);
			show({
				...RUNNING,
				goal: goalOf({ text: "#7", set: null, open: null }),
			});
			await typeGoal(panel, "#7");
			expect(panel.view.goalPending).toBeNull();
			expect(goalRows({ ...panel.view })[2].text).toBe("#7");
		});

		it("drops what was typed on a click elsewhere, which still acts once", async () => {
			const { panel, presses } = await goalPanel(WithGoal);
			await panel.click(fieldRow(panel));
			await panel.pressKey({ text: "9" });
			await panel.click(AWAY_ROW);
			expect(panel.view.goalEdit).toBeNull();
			expect(presses()).toEqual([["set", "--away"]]);
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
			panel.view.goalPending = { on: true, landed: false };
			await panel.click(fieldRow(panel));
			expect(panel.view.goalEdit).toBeNull();
		});
	});

	describe("a refused goal", () => {
		const NotTicked = "wc#5 is in wc, which is not ticked: tick wc first";

		it("shows in place, naming the box, and leaves the old goal showing", async () => {
			const { panel, presses } = await goalPanel(WithGoal, {
				code: 2,
				stderr: `${NotTicked}\n\nusage: refill-loop.js ...\n`,
			});
			await typeGoal(panel, "wc#5");
			expect(panel.view.goalPending).toBeNull();
			expect(presses()).toEqual([["set", "--goal=wc#5"]]);
			const rows: Row[] = buildRows(panel.view, AT);
			const at = rows.findIndex((r) => r.text.startsWith("Goal"));
			expect(rows[at].control?.state).toBe("on");
			expect(rows.slice(at + 2, at + 5).map((r) => r.text)).toEqual([
				"drain #2518 — 5 open, 2 takeable, 1 running",
				"wc#5 is in wc, which is not ticked",
				"tick wc first",
			]);
		});

		it("is gone on the next edit", async () => {
			const { panel } = await goalPanel(WithGoal, {
				code: 2,
				stderr: NotTicked,
			});
			await typeGoal(panel, "wc#5");
			await panel.click(fieldRow(panel));
			expect(panel.view.goalNote).toBeNull();
			expect(panel.view.goalEdit?.text).toBe("drain #2518");
		});

		it("changes no other control's row", async () => {
			const { panel } = await goalPanel(
				{ ...WithGoal, repos: [] },
				{ code: 2, stderr: NotTicked },
			);
			const others = () =>
				buildRows(panel.view, AT)
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
		["inside a text block: the loop's line 2", "Waiting:", 0],
		["inside a text block: the loop's line 3", "Plans this week", 0],
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
		const frame = buildFrame(rows, 80, repoRow, { images: true });
		expect(frame).toContain("[✓]");
		expect(imagesOf(frame)).toBe(controls.length - 1);
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
		expect(findHoverRow(rows, SWITCH_ROW)).toBe(SWITCH_ROW);
		expect(findHoverRow(rows, SWITCH_ROW + 1)).toBeNull();
		expect(findHoverRow(rows, SWITCH_ROW + 999)).toBeNull();
	});
});
