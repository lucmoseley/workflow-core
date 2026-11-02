/*
 * The panel's view and press mapping (#3873, #3875, #3877). Built on the view so every loop state costs one literal rather than a terminal.
 * Broken, the panel reads a press as done, or a stopped loop as on.
 */
import { describe, expect, it } from "vitest";

const {
	ESC,
	buildFrame,
	buildRows,
	createClickReader,
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
	spent: false,
	...over,
});
const STOPPING = { ...RUNNING, stopRequested: true };

/* The block's top row, as a mouse report counts it. */
const SWITCH_ROW = 2;
/* Below the switch and its three lines, two rows clear: the next section. */
const BURN_ROW = 8;
const BURN_INDEX = BURN_ROW - SWITCH_ROW;
const noop = (): void => undefined;

interface Row {
	text: string;
	role: string;
	detail?: string;
	control?: { state: string };
}
const view = (over: object) => ({
	status: null,
	readError: null,
	pending: null,
	refusal: null,
	burnPending: null,
	burnReport: null,
	...over,
});
const rowsOf = (over: object): Row[] => buildRows(view(over), LATER);
const summary = (rows: Row[]) => rows.map((r) => [r.text, r.role]);
const panelOver = (run: unknown, runBurn: unknown = run) =>
	createPanel({ run, runBurn, now: () => AT, onChange: noop });

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
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [on]", "name"],
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
		expect(rowsOf({ status: { ...RUNNING, lastTick } })[2].text).toBe(
			"Waiting: the next check",
		);
	});

	it("never shows a lifted pause's words beside a switch reading on", () => {
		const rows = rowsOf({ status: { ...RUNNING, lastTick: PAUSED_TICK } });
		expect(summary(rows).slice(0, 4)).toEqual([
			["Refill loop  [on]", "name"],
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
		expect(summary(rows).slice(0, 3)).toEqual([
			["Refill loop  […]", "name"],
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
		expect(rows[1].text).toBe("turning on…");
		expect(rows[2].text).toBe("");
	});

	it("names the founder's switching off with its time", () => {
		const rows = rowsOf({ status: PAUSED_BY_FOUNDER });
		expect(summary(rows).slice(0, 3)).toEqual([
			["Refill loop  [off]", "name"],
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
		expect(rowsOf({ status })[1].text).toBe(
			"You switched it off at 2026-10-30 09:07",
		);
	});

	it("says a click starts a paused loop with no process", () => {
		const status = { ...PAUSED_BY_FOUNDER, running: false };
		expect(rowsOf({ status })[2].text).toBe(
			"Not running: switch on to start it",
		);
	});

	it("reads one word, off, for a loop never started, and offers no restart", () => {
		const rows = rowsOf({ status: NEVER_STARTED });
		expect(rows[0].text).toBe("Refill loop  [off]");
		expect(rows[1].text).toBe("off");
		expect(rows[2].text).toBe("Not running: start it from the command line");
	});

	it("reads off with its time for a loop stopped from the command line", () => {
		const rows = rowsOf({ status: STOPPED });
		expect(summary(rows).slice(0, 3)).toEqual([
			["Refill loop  [off]", "name"],
			["off", "value"],
			[
				"Stopped from the command line at 14:05 · click to restart",
				"secondary",
			],
		]);
	});

	it("names the detail of a stop the command line did not ask for", () => {
		const stop = { reason: "control-damaged", at: AT, detail: "bad JSON" };
		expect(rowsOf({ status: { ...STOPPED, stop } })[2].text).toBe(
			"Stopped at 14:05: bad JSON · click to restart",
		);
	});

	it("reads needs you for a crash, with its restart", () => {
		const rows = rowsOf({ status: CRASHED });
		expect(summary(rows).slice(0, 3)).toEqual([
			["Refill loop  [off]", "name"],
			["needs you", "needsYou"],
			["It died with no stop · click to restart", "value"],
		]);
		expect(rows[0].control?.state).toBe("off");
	});

	it("reads needs you for a founder's pause whose process died", () => {
		const status = { ...PAUSED_BY_FOUNDER, running: false, crashed: true };
		expect(summary(rowsOf({ status })).slice(1, 3)).toEqual([
			["needs you", "needsYou"],
			["It died while switched off · click to restart", "value"],
		]);
	});

	it("reads needs you for no progress, with its issues", () => {
		const rows = rowsOf({ status: STALLED });
		expect(summary(rows).slice(0, 3)).toEqual([
			["Refill loop  [off]", "name"],
			["needs you", "needsYou"],
			["No progress: #2518, #2519, #2520 · click to resume", "value"],
		]);
		expect(rows[0].control?.state).toBe("off");
	});

	it("qualifies no progress's issues by repo where they span repos", () => {
		const paused = {
			...STALLED.paused,
			issues: issuesIn("/h/wc", "/h/manta"),
		};
		expect(rowsOf({ status: { ...STALLED, paused } })[2].text).toBe(
			"No progress: wc#2518, manta#2519 · click to resume",
		);
	});

	it("keeps the issues of a no-progress pause whose process died", () => {
		const status = { ...STALLED, running: false, crashed: true };
		expect(rowsOf({ status })[2].text).toContain("#2518");
	});

	it("keeps the switch on through an allowance wait, naming the earliest reset", () => {
		const resets = new Date(2026, 10, 2, 18, 40).getTime();
		const status = { ...RUNNING, lastTick: planWaitTick(resets) };
		const rows = rowsOf({ status });
		expect(rows[0].control?.state).toBe("on");
		expect(rows[2].text).toBe("Waiting: a plan resets at 18:40");
	});

	it("says an allowance wait's reset is unread rather than invent one", () => {
		const status = { ...RUNNING, lastTick: planWaitTick(null) };
		expect(rowsOf({ status })[2].text).toBe(
			"Waiting: a plan resets, its time unread",
		);
	});

	it("reads off, not on, once a stop is asked of a running loop", () => {
		const rows = rowsOf({ status: STOPPING });
		expect(rows[0].control?.state).toBe("off");
		expect(rows[1].text).toBe("off");
		expect(rows[2].text).toBe("Stopping: sessions running finish");
	});

	it("claims neither word while the status is unread", () => {
		expect(rowsOf({})[0].control?.state).toBe("unknown");
		const rows = rowsOf({ readError: "status --json: bad" });
		expect(rows[0].control?.state).toBe("unknown");
		expect(rows[1].text).toBe("Status unreadable");
		expect(rows[2].text).toBe("status --json: bad");
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
	const line3 = (status: object) => rowsOf({ status })[3];

	it("shows each plan seat's week in grey, unread where it will not read", () => {
		const row = line3({ ...RUNNING, seats: planSeats(null) });
		expect(row.text).toBe("Plans this week: .claude3 47%, .claude2 unread");
		expect(row.role).toBe("secondary");
	});

	it("shows nothing about credits with no key declared, every plan full", () => {
		const rows = rowsOf({ status: { ...RUNNING, seats: FULL_SEATS } });
		expect(rows[3].text).toBe("Plans this week: .claude3 100%, .claude2 100%");
		expect(rows[0].detail).toBeUndefined();
	});

	it("shows nothing about credits while a plan has room, a key declared", () => {
		const rows = rowsOf({ status: { ...RUNNING, overflow: [key()] } });
		expect(rows[3].text).toMatch(/^Plans this week/);
		expect(rows[0].detail).toBeUndefined();
	});

	it("shows credits left in white, every key summed, and says so by the switch", () => {
		const overflow = [
			key(),
			key({ headroomUsd: 100, grantUsd: 200 }),
			key({ spent: true, exhausted: true, headroomUsd: 0, grantUsd: 100 }),
		];
		const rows = rowsOf({
			status: { ...RUNNING, seats: FULL_SEATS, overflow },
		});
		expect(rows[3].text).toBe("On API credits: $358 of $700 left");
		expect(rows[3].role).toBe("value");
		expect(rows[0].detail).toBe("API credits · on");
	});

	it("draws the words by the switch outside its bold", () => {
		const status = { ...RUNNING, seats: FULL_SEATS, overflow: [key()] };
		const frame = buildFrame(rowsOf({ status }), 80);
		expect(frame).toContain(`Refill loop  [on]${ESC}[22m  API credits · on`);
	});

	it("says all used up once every key is spent, the switch staying on", () => {
		const status = {
			...RUNNING,
			seats: FULL_SEATS,
			overflow: [key({ spent: true }), key({ spent: true })],
			lastTick: planWaitTick(AT),
		};
		const rows = rowsOf({ status });
		expect(rows[3].text).toBe("Plans and API credits all used up");
		expect(rows[0].control?.state).toBe("on");
		expect(rows[0].detail).toBeUndefined();
	});

	it("never calls credits used up with a key unread", () => {
		const overflow = [key({ spent: true }), { seat: "k", why: "no table" }];
		const row = line3({ ...RUNNING, seats: FULL_SEATS, overflow });
		expect(row.text).toBe("API credits unread: no table");
		expect(row.role).toBe("secondary");
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
		expect(rows[3].text).toMatch(/^Plans this week/);
	});
});

describe("yellow", () => {
	const yellow = "38;2;255;215;0m";
	const framed = (status: object) => buildFrame(rowsOf({ status }), 120);

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
			{ ...RUNNING, seats: FULL_SEATS, overflow: [key({ spent: true })] },
			{ ...RUNNING, lastTick: planWaitTick(AT) },
		])
			expect(framed(status)).not.toContain(yellow);
	});
});

describe("the panel's colours", () => {
	const frame = buildFrame(rowsOf({ status: RUNNING }), 80);

	it("draws names bold white, live values white, secondary text #949494", () => {
		expect(frame).toContain(`${ESC}[1m${ESC}[38;2;242;242;242mRefill loop`);
		expect(frame).toContain(`${ESC}[38;2;242;242;242m3 launched today`);
		expect(frame).toContain(`${ESC}[38;2;148;148;148mWaiting: no free slot`);
	});

	it("uses no blue in any colour it draws", () => {
		const all = frame + buildFrame(rowsOf({ status: CRASHED }), 80);
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
		const frame = buildFrame(rowsOf({ status: long }), 20);
		expect(frame).toContain("Waiting: xxxxxx…");
		expect(frame).not.toContain("x".repeat(20));
	});

	it("erases below its last row, so a report gone from the rows goes from the screen", () => {
		const frame = buildFrame(rowsOf({ status: RUNNING }), 80);
		expect(frame.endsWith(`${ESC}[J`)).toBe(true);
	});

	it("draws no control character a command printed", () => {
		const refusal = { text: `bad${ESC}[31m\nthing`, at: LATER };
		const frame = buildFrame(rowsOf({ status: RUNNING, refusal }), 80);
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
		expect(panel.view.pending).toBeNull();
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
				on: () => ({}),
				off: () => ({}),
			});
			const panel = panelOver(run);
			await panel.refreshStatus();
			for (let row = 1; row < 20; row++) await panel.click(row);
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
		await panel.click(SWITCH_ROW + 1);
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
		expect(buildRows(panel.view, LATER)[1].text).toBe("turning off…");
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
		expect(buildRows(panel.view, LATER)[2].text).toBe(
			"Turning off when this check ends",
		);
	});

	it("clears once a tick has started since the pause", async () => {
		const { panel, show } = await pressed(RUNNING, PAUSED_MID_TICK);
		await show({ ...PAUSED_MID_TICK, lastTick: PAUSED_TICK });
		expect(panel.view.pending).toBeNull();
		expect(buildRows(panel.view, LATER)[1].text).toBe(
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
		expect(rows[2].text).toBe("Waiting: the next check");
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
		expect(rows[2].text).toBe(
			"refill loop: nothing set: the control is damaged",
		);
		expect(buildRows(panel.view, LATER)[2].text).toBe("Waiting: no free slot");
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
	const burnRowsOf = (over: object) => rowsOf(over).slice(BURN_INDEX);
	const burnRows = (panel: { view: object }): Row[] =>
		buildRows(panel.view, LATER).slice(BURN_INDEX);
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

describe("the mouse reader", () => {
	const report = (button: number, col: number, row: number, kind: string) =>
		`${ESC}[<${button};${col};${row}${kind}`;

	it("takes a release in the pressed cell as a click, the first press included", () => {
		const read = createClickReader();
		expect(read(report(0, 5, 2, "M") + report(0, 5, 2, "m")).clicks).toEqual([
			2,
		]);
	});

	it("acts on the release, not the press", () => {
		const read = createClickReader();
		expect(read(report(0, 5, 2, "M")).clicks).toEqual([]);
		expect(read(report(0, 5, 2, "m")).clicks).toEqual([2]);
	});

	it("ignores a release in another cell", () => {
		const read = createClickReader();
		expect(read(report(0, 5, 2, "M") + report(0, 6, 2, "m")).clicks).toEqual(
			[],
		);
	});

	it("ignores any other button and a release with no press", () => {
		const read = createClickReader();
		expect(read(report(2, 5, 2, "M") + report(2, 5, 2, "m")).clicks).toEqual(
			[],
		);
		expect(read(report(0, 5, 2, "m")).clicks).toEqual([]);
	});

	it("reads a report split across chunks", () => {
		const read = createClickReader();
		const whole = report(0, 5, 2, "M") + report(0, 5, 2, "m");
		expect(read(whole.slice(0, 13)).clicks).toEqual([]);
		expect(read(whole.slice(13)).clicks).toEqual([2]);
	});

	it("changes nothing on a typed key, and says so on Ctrl+C", () => {
		const read = createClickReader();
		expect(read("x q ")).toEqual({ clicks: [], interrupted: false });
		expect(read(String.fromCharCode(3)).interrupted).toBe(true);
	});
});
