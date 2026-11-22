// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cutWorktree, defineTemplate, initGitRepo } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";
import { appendStepsOwed, readStepsOwed } from "./lib/steps-owed.js";

const SCRIPT = path.join(__dirname, "steps-owed.js");

const linkedTemplate = defineTemplate((dir) => {
	const hooks = path.join(dir, ".no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(dir, hooks);
	appendStepsOwed(dir, "v2.0.0", [{ type: "act", text: "do a thing" }]);
	execFileSync("git", ["-C", dir, "add", ".claude/workflow-core.json"]);
	execFileSync("git", ["-C", dir, "commit", "-qm", "owe"]);
});

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

	it("clear in a linked worktree writes that tree and leaves the main checkout clean (#5287)", () => {
		linkedTemplate.instantiate(root);
		const tree = cutWorktree(root);
		const r = runInProcess(SCRIPT, ["clear", "v2.0.0", "act", "do a thing"], {
			cwd: tree,
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("cleared v2.0.0 [act]");
		expect(readStepsOwed(tree)).toEqual([]);
		expect(
			execFileSync("git", ["-C", root, "status", "--porcelain"], {
				encoding: "utf8",
			}),
		).toBe("");
	});

	it("prints usage on a bad invocation", () => {
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: steps-owed.js");
	});
});
