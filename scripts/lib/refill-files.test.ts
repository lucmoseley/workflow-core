// @vitest-environment node
/*
 * The refill loop's file reads (#3380, #3389). Loosen one and a damaged state
 * file stops the loop or goes unlogged, or a damaged control reads as a loop
 * nobody started.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decideTick } from "./refill-decide.js";
import { readControlChecked, readJson } from "./refill-files.js";
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

describe("the tick's control read (#3389)", () => {
	let tmp: string;
	const saved = process.env.WFC_REFILL_DIR;
	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "refill-control-"));
		process.env.WFC_REFILL_DIR = tmp;
	});
	afterEach(() => {
		if (saved === undefined) delete process.env.WFC_REFILL_DIR;
		else process.env.WFC_REFILL_DIR = saved;
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
			startedAt: NOW,
			stopRequested: true,
			controlDamaged: damaged,
			frontier: [],
			retroBundles: [],
			running: [],
			freeSlots: 1,
			lastPromptAt: null,
			seats: [],
			history: [],
		});

	it("reads an absent control as none, not damaged, so a real tick stops as explicit", () => {
		const r = read();
		expect(r).toEqual({ control: null, damaged: null, lines: [] });
		expect(decided(r.damaged)).toMatchObject({ stop: "explicit" });
	});

	it.each([
		["unparseable", "{ not json", /JSON/],
		["a JSON null", "null", /no startedAt/],
		["not a control", JSON.stringify({ stopRequested: false }), /no startedAt/],
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

	it("reads a whole control as itself", () => {
		fs.writeFileSync(file(), JSON.stringify({ startedAt: 5 }));
		expect(read()).toMatchObject({ control: { startedAt: 5 }, damaged: null });
	});
});
