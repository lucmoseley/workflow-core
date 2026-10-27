// @vitest-environment node
/*
 * steps-owed.test.ts — the CLI over lib/steps-owed.js (#248): the only
 * discharge route for `stepsOwed` outside the walker.
 *
 * Runs in-process against a temp project dir holding its own
 * `.claude/workflow-core.json`, so no case touches this repo's owed steps.
 * Loosen it and a migration's manual step is cleared without a match and lost,
 * or can never be discharged and is reported as owed at every session start.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { appendStepsOwed, readStepsOwed } from "./lib/steps-owed.js";

const SCRIPT = path.join(__dirname, "steps-owed.js");

let root = "";
let made: string[] = [];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "steps-owed-cli-"));
	made.push(root);
});
afterEach(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
	made = [];
});

const run = (argv: string[]) =>
	runInProcess(SCRIPT, argv, {
		env: { ...process.env, CLAUDE_PROJECT_DIR: root },
	});

describe("steps-owed.js CLI", () => {
	it("list prints an empty array where nothing is owed", () => {
		const r = run(["list"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual([]);
	});

	it("list prints every owed entry", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "act", text: "do a thing" }]);
		const r = run(["list"]);
		expect(JSON.parse(r.stdout)).toEqual([
			{ tag: "v2.0.0", type: "act", text: "do a thing" },
		]);
	});

	it("clear discharges a matching entry", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "notice", text: "fyi" }]);
		const r = run(["clear", "v2.0.0", "notice", "fyi"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("cleared v2.0.0 [notice]");
		expect(readStepsOwed(root)).toEqual([]);
	});

	it("clear exits 1 on no match", () => {
		const r = run(["clear", "v2.0.0", "notice", "nope"]);
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("no matching entry");
	});

	it("decline marks a choice declined without removing it", () => {
		appendStepsOwed(root, "v2.0.0", [{ type: "choice", text: "pick" }]);
		const r = run(["decline", "v2.0.0", "pick"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("declined v2.0.0 [choice]");
		expect(readStepsOwed(root)).toEqual([
			{ tag: "v2.0.0", type: "choice", text: "pick", declined: true },
		]);
	});

	it("refuses an unknown type on clear with usage-shaped guidance", () => {
		const r = run(["clear", "v2.0.0", "bogus", "x"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("one of act/choice/notice");
	});

	it("prints usage on a bad invocation", () => {
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: steps-owed.js");
	});
});
