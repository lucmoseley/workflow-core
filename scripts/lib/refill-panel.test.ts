/*
 * The panel's view and press mapping (#3873). Built on the view so every loop state costs one literal rather than a terminal.
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

const RUNNING = {
	running: true,
	stopRequested: false,
	codeSha: "abc1234",
	paused: null,
	lastTick: {
		at: AT,
		summary: "idle: no free slot",
		idle: "no free slot",
		paused: false,
	},
	launchesToday: 3,
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
const STOPPED = { ...RUNNING, running: false, codeSha: null };
const STOPPING = { ...RUNNING, stopRequested: true };

/* The block's top row, as a mouse report counts it. */
const SWITCH_ROW = 2;
const noop = (): void => undefined;

interface Row {
	text: string;
	role: string;
	control?: { state: string };
}
const view = (over: object) => ({
	status: null,
	readError: null,
	pending: null,
	refusal: null,
	...over,
});
const rowsOf = (over: object): Row[] => buildRows(view(over), LATER);
const summary = (rows: Row[]) => rows.map((r) => [r.text, r.role]);
const panelOver = (run: unknown) =>
	createPanel({ run, now: () => AT, onChange: noop });

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
		expect(summary(rows)).toEqual([
			["Refill loop  [on]", "name"],
			["3 launched today", "value"],
			["Waiting: no free slot", "secondary"],
			["abc1234 · idle: no free slot", "secondary"],
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
		expect(summary(rows)).toEqual([
			["Refill loop  [on]", "name"],
			["3 launched today", "value"],
			["Waiting: the next check", "secondary"],
			["abc1234", "secondary"],
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

	it("says what a click cannot do for a paused loop with no process", () => {
		const status = { ...PAUSED_BY_FOUNDER, running: false };
		expect(rowsOf({ status })[2].text).toBe(
			"Not running: switch on, then start it from the command line",
		);
	});

	it("reads one word, off, for a loop not running", () => {
		const rows = rowsOf({ status: STOPPED });
		expect(rows[0].text).toBe("Refill loop  [off]");
		expect(rows[1].text).toBe("off");
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
			{ status: { ...RUNNING, lastTick: null, codeSha: null } },
			{ status: PAUSED_BY_FOUNDER },
			{ status: { ...PAUSED_BY_FOUNDER, running: false } },
			{ status: STOPPED },
			{ status: STOPPING },
			{ status: RUNNING, pending: { on: false, landed: true } },
			{ status: PAUSED_BY_FOUNDER, pending: { on: true, landed: false } },
			{ status: RUNNING, refusal: { text: "refused", at: LATER } },
		];
		for (const c of cases) expect(rowsOf(c)).toHaveLength(4);
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
		for (const [, r, g, b] of frame.matchAll(/38;2;(\d+);(\d+);(\d+)m/g))
			expect(Number(b)).toBeLessThanOrEqual(Math.max(Number(r), Number(g)));
	});
});

describe("the panel's frame", () => {
	it("cuts a long row rather than wrapping it into the next", () => {
		const long = {
			...RUNNING,
			lastTick: { at: AT, summary: "x".repeat(99), idle: null, paused: false },
		};
		const frame = buildFrame(rowsOf({ status: long }), 20);
		expect(frame).toContain("abc1234 · xxxxx…");
		expect(frame).not.toContain("x".repeat(20));
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

	it("runs nothing before a read, or off the switch row", async () => {
		const { calls, run } = runnerOf({ "status --json": showing(RUNNING) });
		const panel = panelOver(run);
		await panel.click(SWITCH_ROW);
		expect(calls).toEqual([]);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW + 1);
		expect(calls).toHaveLength(1);
	});

	it.each([
		["no process and no pause", STOPPED],
		["a stop asked", STOPPING],
	])("runs nothing for a loop with %s", async (_name, status) => {
		const { calls, run } = runnerOf({ "status --json": showing(status) });
		const panel = panelOver(run);
		await panel.refreshStatus();
		await panel.click(SWITCH_ROW);
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
