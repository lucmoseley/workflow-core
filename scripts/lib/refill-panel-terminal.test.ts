// @vitest-environment node
/*
 * The panel's terminal wiring (#3873): what it asks of the terminal on opening,
 * and what it hands back on each way out, over injected streams and a fake process,
 * so a signal costs no real process. Broken, a crash leaves the founder's pane raw
 * and in mouse mode, or the panel outlives its agents view.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openPanel } = require("./refill-panel-terminal.js");

const ESC = String.fromCharCode(27);
const RESTORE = `${ESC}[?1004l${ESC}[?1003l${ESC}[?2004l${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`;
const STATUS = JSON.stringify({
	running: true,
	stopRequested: false,
	codeSha: "abc1234",
	paused: null,
	lastTick: null,
	launchesToday: 0,
	repos: [],
	seats: { readings: [] },
	overflow: [],
	burnMode: { on: false, disagreeing: [], error: null },
});
const noop = (): void => undefined;

function terminal(over: object = {}) {
	const written: string[] = [];
	const raw: boolean[] = [];
	const stdin = Object.assign(new EventEmitter(), {
		setRawMode: (on: boolean) => raw.push(on),
		setEncoding: noop,
		resume: noop,
	});
	const stdout = Object.assign(new EventEmitter(), {
		columns: 80,
		write: (s: string) => written.push(s),
	});
	const exits: number[] = [];
	const proc = Object.assign(new EventEmitter(), {
		exit: (code: number) => {
			exits.push(code);
			proc.emit("exit");
		},
	});
	const crashes: unknown[] = [];
	let alive = true;
	const calls: string[][] = [];
	openPanel({
		pid: 4242,
		stdin,
		stdout,
		proc,
		run: async (argv: string[]) => {
			calls.push(argv);
			return { code: 0, stdout: STATUS, stderr: "" };
		},
		isAlive: () => alive,
		now: () => 0,
		reportCrash: (err: unknown) => crashes.push(err),
		...over,
	});
	return {
		calls,
		crashes,
		exits,
		proc,
		raw,
		stdin,
		text: () => written.join(""),
		goGone: () => {
			alive = false;
		},
	};
}

describe("the panel's terminal", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens raw, on the alternate screen, with SGR mouse reports", () => {
		const t = terminal();
		expect(t.raw).toEqual([true]);
		expect(t.text()).toContain(`${ESC}[?1049h`);
		expect(t.text()).toContain(`${ESC}[?1000h${ESC}[?1006h`);
		expect(t.text()).toContain(`${ESC}[?2004h`);
	});

	it.each([
		["SIGTERM", 143],
		["SIGHUP", 129],
		["SIGINT", 130],
	])("restores the terminal on %s", (signal, code) => {
		const t = terminal();
		t.proc.emit(signal);
		expect(t.text()).toContain(RESTORE);
		expect(t.raw).toEqual([true, false]);
		expect(t.exits).toEqual([code]);
	});

	it("restores the terminal on a crash, before saying what crashed", () => {
		const t = terminal();
		t.proc.emit("uncaughtException", new Error("boom"));
		expect(t.text()).toContain(RESTORE);
		expect(t.crashes).toHaveLength(1);
		expect(t.exits).toEqual([1]);
	});

	it("restores once however many ways out fire", () => {
		const t = terminal();
		t.proc.emit("SIGTERM");
		t.proc.emit("exit");
		expect(t.text().split(RESTORE)).toHaveLength(2);
	});

	it("still exits where restoring itself throws", () => {
		let gone = false;
		const stdout = Object.assign(new EventEmitter(), {
			columns: 80,
			write: () => {
				if (gone) throw new Error("EIO");
			},
		});
		const t = terminal({ stdout });
		gone = true;
		t.proc.emit("SIGHUP");
		expect(t.exits).toEqual([129]);
	});

	it("exits when the watched pid goes, and not before", () => {
		const t = terminal();
		vi.advanceTimersByTime(5000);
		expect(t.exits).toEqual([]);
		t.goGone();
		vi.advanceTimersByTime(1000);
		expect(t.exits).toEqual([0]);
		expect(t.text()).toContain(RESTORE);
	});

	it("exits on Ctrl+C", () => {
		const t = terminal();
		t.stdin.emit("data", String.fromCharCode(3));
		expect(t.exits).toEqual([0]);
	});

	it("hands a click on the Burn mode switch to the script's runner, not the loop's", async () => {
		const flips: string[][] = [];
		const t = terminal({
			runBurn: async (argv: string[]) => {
				flips.push(argv);
				return { code: 0, stdout: "", stderr: "" };
			},
		});
		await vi.advanceTimersByTimeAsync(0);
		const cell = "5;11";
		t.stdin.emit("data", `${ESC}[<0;${cell}M${ESC}[<0;${cell}m`);
		await vi.advanceTimersByTimeAsync(0);
		expect(flips).toEqual([["on"]]);
		expect(t.calls.flat()).not.toContain("on");
	});

	describe("the goal field", () => {
		/* The switch's row with no burn report: its section sits below Burn mode. */
		const GoalRow = 14;
		const FieldRow = GoalRow + 2;
		const clickRow = (t: ReturnType<typeof terminal>, row: number) =>
			t.stdin.emit("data", `${ESC}[<0;5;${row}M${ESC}[<0;5;${row}m`);
		const statusWithGoal = JSON.stringify({
			...JSON.parse(STATUS),
			goal: { text: "#7", set: null },
		});
		const open = async () => {
			const presses: string[][] = [];
			const t = terminal({
				run: async (argv: string[]) => {
					if (argv[0] !== "status") presses.push(argv);
					return { code: 0, stdout: statusWithGoal, stderr: "" };
				},
			});
			await vi.advanceTimersByTimeAsync(0);
			clickRow(t, FieldRow);
			return { t, presses };
		};

		it("saves what was typed on Enter", async () => {
			const { t, presses } = await open();
			t.stdin.emit("data", "1\r");
			await vi.advanceTimersByTimeAsync(0);
			expect(presses).toEqual([["set", "--goal=#71"]]);
		});

		it("takes a lone escape as Esc once the wait is over, and not before", async () => {
			const { t, presses } = await open();
			t.stdin.emit("data", "1");
			t.stdin.emit("data", ESC);
			await vi.advanceTimersByTimeAsync(10);
			t.stdin.emit("data", "2");
			await vi.advanceTimersByTimeAsync(100);
			t.stdin.emit("data", ESC);
			await vi.advanceTimersByTimeAsync(100);
			t.stdin.emit("data", "\r");
			await vi.advanceTimersByTimeAsync(0);
			expect(presses).toEqual([]);
		});

		it("does not take an escape that starts a sequence as Esc", async () => {
			const { t, presses } = await open();
			t.stdin.emit("data", ESC);
			t.stdin.emit("data", "[D");
			await vi.advanceTimersByTimeAsync(100);
			t.stdin.emit("data", "1\r");
			await vi.advanceTimersByTimeAsync(0);
			expect(presses).toEqual([["set", "--goal=#17"]]);
		});
	});

	it("polls the status and runs nothing else with no click", async () => {
		const t = terminal();
		await vi.advanceTimersByTimeAsync(9000);
		expect(t.calls.length).toBeGreaterThan(1);
		expect(new Set(t.calls.map((c) => c.join(" ")))).toEqual(
			new Set(["status --json"]),
		);
	});
});

describe("the images' fallback", () => {
	const Dcs = `${ESC}P`;
	const Sixel = `${ESC}[?61;4;6;7c`;
	const Cell = `${ESC}[6;20;10t`;
	const HoverOn = `${ESC}[?1003h`;
	/* The switch's row, as a mouse report counts it. */
	const SwitchRow = 2;
	const settled = async (t: ReturnType<typeof terminal>) => {
		await vi.advanceTimersByTimeAsync(0);
		return t;
	};
	const frameAfter = (t: ReturnType<typeof terminal>, ...answers: string[]) => {
		for (const answer of answers) t.stdin.emit("data", answer);
		return t.text();
	};

	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("asks for device attributes and the cell size on opening", () => {
		expect(terminal().text()).toContain(`${ESC}[c${ESC}[16t`);
	});

	it.each([
		["no answer", []],
		["Sixel not reported", [`${ESC}[?61;6;7c`, Cell]],
		["Sixel with another cell size", [Sixel, `${ESC}[6;16;8t`]],
		["Sixel with no cell answer", [Sixel]],
		["the cell with no attributes answer", [Cell]],
	])(
		"keeps the text controls and asks for no motion on %s",
		async (_, answers) => {
			const t = await settled(terminal());
			const text = frameAfter(t, ...answers);
			expect(text).not.toContain(Dcs);
			expect(text).not.toContain(HoverOn);
			expect(text).toContain("[on]");
		},
	);

	it("draws images once both answers say they fit, in either order", async () => {
		for (const answers of [
			[Sixel, Cell],
			[Cell, Sixel],
		]) {
			const t = await settled(terminal());
			const text = frameAfter(t, ...answers);
			expect(text).toContain(Dcs);
			expect(text).toContain(HoverOn);
		}
	});

	it("redraws on a move onto a control, and not along a row with none", async () => {
		const t = await settled(terminal());
		frameAfter(t, Sixel, Cell);
		const before = t.text().length;
		t.stdin.emit("data", `${ESC}[<35;5;${SwitchRow + 1}M`);
		expect(t.text().length).toBe(before);
		t.stdin.emit("data", `${ESC}[<35;5;${SwitchRow}M`);
		const grown = t.text().length;
		expect(grown).toBeGreaterThan(before);
		t.stdin.emit("data", `${ESC}[<35;6;${SwitchRow}M`);
		expect(t.text().length).toBe(grown);
	});

	it("ends the hover when the pane loses focus", async () => {
		const t = await settled(terminal());
		frameAfter(t, Sixel, Cell);
		t.stdin.emit("data", `${ESC}[<35;5;${SwitchRow}M`);
		const grown = t.text().length;
		t.stdin.emit("data", `${ESC}[O`);
		expect(t.text().length).toBeGreaterThan(grown);
	});

	it("takes no hover from motion in a terminal with no images", async () => {
		const t = await settled(terminal());
		const before = t.text().length;
		t.stdin.emit("data", `${ESC}[<35;5;${SwitchRow}M`);
		expect(t.text().length).toBe(before);
	});
});
