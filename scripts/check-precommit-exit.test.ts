// @vitest-environment node
/*
 * Pins check-precommit-exit.js's boundary set (base §X11): each exit, argv
 * and --index, and the real reads of .husky/pre-commit and
 * .husky/pre-commit.local. Which lines exit 1 on a checker's failure is
 * lib/precommit-exit.test.ts's (§N4, #3456, #4652).
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets a
 * checker that could not run reach the committer as a finding again.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-precommit-exit.js");

let root: string;

const hook = (name: string, body: string) => {
	fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".husky", name),
		`#!/usr/bin/env sh\n${body}`,
	);
};

const run = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: root },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-exit-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-precommit-exit", () => {
	it("FAILs a node checker line, naming file, line, the primitive and its exemplar", () => {
		hook(
			"pre-commit",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'set -e\nnode "${WFC_PLUGIN_ROOT:-.}"/scripts/check-a.js || exit 1\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 checker line(s) exiting 1 on failure");
		expect(r.out).toContain(
			"1 checker line(s) exit 1 on failure: .husky/pre-commit:3.",
		);
		expect(r.out).toContain(
			"Fix: pass the checker's own exit code on with `|| exit \"$?\"` (in a block, `|| { rc=$?; ...; exit \"$rc\"; }`), or gate it through staged_gate's `status` mode in scripts/lib/precommit-gate.sh, as .husky/pre-commit's check-jsonl-reads.js line does; where the hook reads a probe's or lister's output, its crash exits 2, since a crash's own code may be 1 (base §N4, #3456, #3808).",
		);
	});

	it("FAILs a breach in .husky/pre-commit.local", () => {
		hook("pre-commit.local", "node scripts/check-own.js || exit 1\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".husky/pre-commit.local:2.");
	});

	it("passes checker lines passing their exit code on, and a commented-out breach", () => {
		hook(
			"pre-commit",
			'node scripts/check-a.js || exit "$?"\n# node scripts/check-b.js || exit 1\n',
		);
		hook("pre-commit.local", 'bash scripts/gate.sh || exit "$?"\n');
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 2 pre-commit file(s), every checker line passing its exit code on.",
		);
	});

	it("reads OK with neither hook present", () => {
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 0 pre-commit file(s)");
	});

	it("exits 2 on an unknown flag, naming it and the usage", () => {
		const r = run("--bogus");
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN: unknown flag: --bogus");
		expect(r.out).toContain(
			"usage: node check-precommit-exit.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
		);
	});
});

describe("--index (#3687)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });
	const breach = "node scripts/check-x.js || exit 1\n";

	beforeEach(() => {
		git("init", "-q");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		hook("pre-commit", 'node scripts/check-x.js || exit "$?"\n');
		git("add", ".");
		git("commit", "-qm", "seed");
	});

	it("passes a breach left unstaged in the working tree", () => {
		hook("pre-commit", breach);
		expect(run().status).toBe(1);
		const r = run("--index");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 pre-commit file(s)");
	});

	it("refuses the same breach once staged, naming its file and line", () => {
		hook("pre-commit", breach);
		git("add", ".husky/pre-commit");
		const r = run("--index", "--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).findings).toMatchObject([
			{ tag: "PRECOMMIT-EXIT", file: ".husky/pre-commit", line: 2 },
		]);
	});
});
