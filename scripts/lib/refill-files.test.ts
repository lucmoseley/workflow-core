// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decideTick } from "./refill-decide.js";
import {
	appendLoopLog,
	readControlChecked,
	withControlLock,
} from "./refill-files.js";
import { readJson } from "./refill-json.js";
import { NOW } from "./refill-loop-fixture";

describe("a loop file's read (#3380)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refill-read-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("reads an absent file as null, logging nothing", () => {
		const lines: string[] = [];
		expect(readJson(path.join(tmp, "absent.json"), (l) => lines.push(l))).toBe(
			null,
		);
		expect(lines).toEqual([]);
	});

	it("reads a damaged file as null, logging its path and the parse error", () => {
		const file = path.join(tmp, ".refill-loop-state.json");
		fs.writeFileSync(file, "{ not json");
		const lines: string[] = [];
		expect(readJson(file, (l) => lines.push(l))).toBe(null);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(file);
		expect(lines[0]).toMatch(/JSON/);
	});
});

describe("the control lock (#3856)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refill-lock-"));
		vi.stubEnv("WFC_REFILL_DIR", tmp);
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("refuses past its wait while a live holder keeps it, running nothing and saying what to do", () => {
		const holder = spawn(
			process.execPath,
			["-e", "setInterval(() => {}, 1000)", "refill-loop.js"],
			{ stdio: "ignore" },
		);
		try {
			const file = path.join(tmp, ".refill-loop-control.json.lock");
			fs.writeFileSync(file, String(holder.pid));
			let ran = false;
			const r = withControlLock(() => {
				ran = true;
			}, 0);
			expect(ran).toBe(false);
			expect(r).toEqual({
				busy: `${file} is held by pid ${holder.pid}`,
			});
		} finally {
			holder.kill();
		}
	});

	it("releases the lock after the write, a throwing one too", () => {
		const file = path.join(tmp, ".refill-loop-control.json.lock");
		expect(withControlLock(() => 1)).toEqual({ done: 1 });
		expect(fs.existsSync(file)).toBe(false);
		expect(() =>
			withControlLock(() => {
				throw new Error("no");
			}),
		).toThrow("no");
		expect(fs.existsSync(file)).toBe(false);
	});
});

describe("the tick's control read (#3389)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refill-control-"));
		vi.stubEnv("WFC_REFILL_DIR", tmp);
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});
	const file = () => path.join(tmp, ".refill-loop-control.json");
	const read = () => {
		const lines: string[] = [];
		return { ...readControlChecked((l) => lines.push(l)), lines };
	};
	const decided = (damaged: string | null) =>
		decideTick({
			now: NOW,
			mode: "normal" as const,
			runFrom: NOW,
			stopRequested: true,
			controlDamaged: damaged,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 1,
			seats: [],
			history: [],
			lastActAt: {},
		});

	it("reads an absent control as none, not damaged, so a real tick stops as explicit", () => {
		const r = read();
		expect(r).toEqual({ control: null, damaged: null, lines: [] });
		expect(decided(r.damaged)).toMatchObject({ stop: "explicit" });
	});

	it.each([
		["unparseable", "{ not json", /JSON/],
		["a JSON null", "null", /not a JSON object/],
		["a JSON number", "5", /not a JSON object/],
	])(
		"stops on an %s control under its own reason, naming the file",
		(_, body, why) => {
			fs.writeFileSync(file(), body);
			const r = read();
			expect(r.control).toBeNull();
			expect(r.damaged).toContain(file());
			expect(r.damaged).toMatch(why);
			expect(r.lines).toEqual([
				`${r.damaged}; the loop stops on it until a start rewrites it`,
			]);
			expect(decided(r.damaged)).toEqual({
				stop: "control-damaged",
				detail: r.damaged,
			});
		},
	);

	it("reads a control with no run start as run from 0, ignoring fields it no longer knows (#5767)", () => {
		fs.writeFileSync(
			file(),
			JSON.stringify({
				countFrom: 5,
				stopRequested: false,
				repoPaused: { "/a": { by: "x", at: 3 } },
			}),
		);
		const r = read();
		expect(r.damaged).toBeNull();
		expect(r.control).toMatchObject({ runFrom: 0, stopRequested: false });
		expect(r.control).not.toHaveProperty("repoPaused");
		expect(r.control).not.toHaveProperty("countFrom");
	});

	it("reads a whole control as itself", () => {
		fs.writeFileSync(file(), JSON.stringify({ runFrom: 5 }));
		expect(read()).toMatchObject({
			control: { runFrom: 5 },
			damaged: null,
		});
	});

	describe("its goal (#3864)", () => {
		const writeGoal = (goal: unknown) =>
			fs.writeFileSync(
				file(),
				JSON.stringify({
					runFrom: 5,
					stopRequested: false,
					seats: [],
					scope: { mode: "normal", repos: ["/r/wfc"], goal },
				}),
			);

		it("logs a garbled goal and reads the control bare, not damaged", () => {
			writeGoal("soon");
			const r = read();
			expect(r.damaged).toBeNull();
			expect(r.control?.scope.goal).toBeNull();
			expect(r.lines).toEqual([
				`${file()}'s goal is garbled; the loop runs bare until a set replaces it`,
			]);
		});

		it("reads a confirmed topic's set as stored, logging nothing", () => {
			const goal = {
				form: "topic",
				text: "faster tests",
				refs: [{ repo: "wfc", number: 7 }],
				setAt: 3,
			};
			writeGoal(goal);
			const r = read();
			expect(r.control?.scope.goal).toEqual(goal);
			expect(r.lines).toEqual([]);
		});
	});
});

describe("the loop's log (#4186)", () => {
	let tmp: string;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refill-log-"));
	});
	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it("appends each line stamped, making a missing directory", () => {
		const dir = path.join(tmp, "not-yet");
		vi.stubEnv("WFC_REFILL_DIR", dir);
		appendLoopLog("one");
		appendLoopLog("two");
		const text = fs.readFileSync(path.join(dir, ".refill-loop.log"), "utf8");
		expect(text).toMatch(
			/^\d{4}-\d\d-\d\dT\S+Z one\n\d{4}-\d\d-\d\dT\S+Z two\n$/,
		);
	});
});
