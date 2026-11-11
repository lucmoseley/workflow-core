// @vitest-environment node
/*
 * Pins that check-hand-callers.js FAILs a hand-kept `Caller:` header line in
 * a script, naming file and line, and that --against refuses only a line the
 * commit adds (#4720, #4885).
 *
 * Run against a fabricated tree in a throwaway git repo, never this one.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here loosens
 * that gate.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-hand-callers.js");

let root: string;
let hooks: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: root, stdio: "pipe" });

const write = (rel: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

const commit = (message: string) => {
	git("add", ".");
	git("commit", "-qm", message);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "hand-callers-"));
	/* An empty hooks dir, so the scratch repo never runs this checkout's
	 * Husky gates through its absolute core.hooksPath. */
	hooks = fs.mkdtempSync(path.join(os.tmpdir(), "hand-callers-hooks-"));
	git("init", "-q", "-b", "main");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("config", "core.hooksPath", hooks);
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

describe("check-hand-callers", () => {
	it("FAILs a Caller:, Callers: or Callers of …: header line, naming file and line", () => {
		write(
			"scripts/one.js",
			"/*\n * one.js — a thing.\n *\n * Caller: scripts/two.js\n */\n",
		);
		write("scripts/lib/two.js", "// Callers: scripts/one.js\n");
		write(
			".claude/skills/s/scripts/three.js",
			"/**\n * Callers of runThing: scripts/one.js\n */\n",
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("scripts/one.js:4  Caller: scripts/two.js — ");
		expect(r.out).toContain("scripts/lib/two.js:1  Callers: scripts/one.js");
		expect(r.out).toContain(
			".claude/skills/s/scripts/three.js:2  Callers of runThing:",
		);
	});

	it("reads a shell or Python script's # header and docstring, and a TS header", () => {
		write(
			"scripts/lib/marker.sh",
			"#!/usr/bin/env bash\n# marker.sh\n#\n# Callers: scripts/a.sh\nset -e\n# Caller: below the header\n",
		);
		write(
			"scripts/tool.py",
			'#!/usr/bin/env python3\n"""tool.py\n\nCaller: scripts/b.js\n"""\n',
		);
		write("scripts/lib/r.ts", "/*\n * Caller: vitest.config.ts\n */\n");
		const r = run();
		expect(r.out).toContain("scripts/lib/marker.sh:4");
		expect(r.out).not.toContain("below the header");
		expect(r.out).toContain("scripts/tool.py:4");
		expect(r.out).toContain("scripts/lib/r.ts:2");
	});

	it("passes an Unbuilt caller: line, a Caller: line outside the header, and a file out of scope", () => {
		write(
			"scripts/early.js",
			"/*\n * Unbuilt caller: scripts/report.js (#575)\n */\n",
		);
		write(
			"scripts/late.js",
			"/* header */\nconst x = 1;\n// Caller: scripts/report.js\n",
		);
		write("lib/app.js", "// Caller: app/page.tsx\n");
		write("scripts/notes.md", "Caller: scripts/late.js\n");
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 2 script header(s)");
	});

	describe("--against HEAD", () => {
		it("refuses a commit whose staged header gains a Caller: line, judging the index, not the worktree", () => {
			write("scripts/a.js", "/*\n * a.js\n */\n");
			commit("seed");
			write("scripts/a.js", "/*\n * a.js\n *\n * Caller: scripts/b.js\n */\n");
			git("add", ".");
			const refused = run("--against", "HEAD");
			expect(refused.status).toBe(1);
			expect(refused.out).toContain("scripts/a.js:4  Caller: scripts/b.js");
			/* Removed in the worktree but not staged: the commit still carries it. */
			write("scripts/a.js", "/*\n * a.js\n */\n");
			expect(run("--against", "HEAD").status).toBe(1);
		});

		it("passes a commit that gains an Unbuilt caller: line", () => {
			write("scripts/a.js", "/*\n * a.js\n */\n");
			commit("seed");
			write(
				"scripts/a.js",
				"/*\n * a.js\n *\n * Unbuilt caller: scripts/b.js (#575)\n */\n",
			);
			git("add", ".");
			expect(run("--against", "HEAD").status).toBe(0);
		});

		it("lets an inherited line through when a line added above moves it", () => {
			write("scripts/a.js", "/*\n * Caller: scripts/b.js\n */\n");
			commit("seed");
			write("scripts/a.js", "/*\n * a.js\n *\n * Caller: scripts/b.js\n */\n");
			git("add", ".");
			expect(run("--against", "HEAD").status).toBe(0);
		});
	});
});
