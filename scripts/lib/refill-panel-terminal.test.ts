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
const RESTORE = `${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`;
const STATUS = JSON.stringify({
	running: true,
	stopRequested: false,
	codeSha: "abc1234",
	paused: null,
	lastTick: null,
	launchesToday: 0,
	repos: [],
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
		const cell = "5;10";
		t.stdin.emit("data", `${ESC}[<0;${cell}M${ESC}[<0;${cell}m`);
		await vi.advanceTimersByTimeAsync(0);
		expect(flips).toEqual([["on"]]);
		expect(t.calls.flat()).not.toContain("on");
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
