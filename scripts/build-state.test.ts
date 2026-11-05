// @vitest-environment node
/*
 * build-state.test.ts — `/implement`'s opening step: create or resume a build
 * unit's state file, keyed by issue number (#4410). Rooted on a temp
 * WFC_REPO_ROOT, so no run writes the live checkout's state files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "build-state.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-state-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const file = (n: number) =>
	path.join(dir, ".claude", "tmp", "build-state", `${n}.json`);
const run = (args: string[]) =>
	runInProcess(SCRIPT, args, {
		env: { ...process.env, WFC_REPO_ROOT: dir },
	});

describe("build-state.js", () => {
	it("creates the file in the spec's shape and prints its path", () => {
		const r = run(["4419", "--spec", "4410"]);
		expect(r.status).toBe(0);
		expect(r.stdout.split("\n")[0]).toBe(`Created ${file(4419)}`);
		const state = JSON.parse(fs.readFileSync(file(4419), "utf8"));
		expect(Object.keys(state)).toEqual([
			"issue",
			"spec",
			"slices",
			"standingRules",
			"filesTouched",
			"next",
			"updatedAt",
		]);
		expect([state.issue, state.spec, state.slices]).toEqual([4419, 4410, []]);
	});

	it("resumes a predecessor's file unchanged, by issue number alone", () => {
		fs.mkdirSync(path.dirname(file(4419)), { recursive: true });
		const theirs = `${JSON.stringify({ issue: 4419, next: "slice 4" })}\n`;
		fs.writeFileSync(file(4419), theirs);
		const r = run(["4419"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Resumed ${file(4419)}`);
		expect(r.stdout).toContain('"next":"slice 4"');
		expect(fs.readFileSync(file(4419), "utf8")).toBe(theirs);
	});

	it("records a null spec where none is passed", () => {
		expect(run(["12"]).status).toBe(0);
		expect(JSON.parse(fs.readFileSync(file(12), "utf8")).spec).toBeNull();
	});

	it("exits 1 on a file that does not parse, leaving it", () => {
		fs.mkdirSync(path.dirname(file(5)), { recursive: true });
		fs.writeFileSync(file(5), "{torn");
		const r = run(["5"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${file(5)}: `);
		expect(fs.readFileSync(file(5), "utf8")).toBe("{torn");
	});

	it.each([[[]], [["x"]], [["5", "--spec", "y"]]])(
		"exits 2 on bad usage %j",
		(args) => {
			const r = run(args);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage: node scripts/build-state.js <n>");
		},
	);
});
