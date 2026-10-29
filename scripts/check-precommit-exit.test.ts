// @vitest-environment node
/*
 * Pins which pre-commit lines check-precommit-exit.js finds exiting 1 on a
 * checker's failure, in .husky/pre-commit and .husky/pre-commit.local, which
 * outside commands it leaves alone, and that its refusal names the primitive
 * and its exemplar (§N4, #3456).
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
			'Fix: pass the checker\'s own exit code on with `|| exit "$?"` (in a block, `|| { rc=$?; ...; exit "$rc"; }`), or gate it through staged_gate\'s `status` mode in scripts/lib/precommit-gate.sh, as .husky/pre-commit\'s check-jsonl-reads.js line does (base §N4, #3456).',
		);
	});

	it.each([
		["a bash script", 'bash "$WFC_PLUGIN_ROOT"/scripts/gate.sh || exit 1'],
		["an sh script", "sh scripts/gate.sh || exit 1"],
		["a script run directly", "./scripts/check-b.js || exit 1"],
		["node past its flags", "node --no-warnings scripts/check-b.js || exit 1"],
		[
			"an indented line in an if",
			"if armed x; then\n  node scripts/c.js || exit 1\nfi",
		],
		["a trailing comment", "node scripts/c.js || exit 1 # why"],
		["a variable assignment", "X=1 node scripts/c.js || exit 1"],
	])("FAILs %s", (_, line) => {
		hook("pre-commit", `${line}\n`);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 1 checker line(s) exiting 1 on failure");
	});

	it("FAILs a bash script run under errexit", () => {
		hook("pre-commit", "bash -e scripts/gate.sh || exit 1\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".husky/pre-commit:2.");
	});

	it("FAILs a block exiting 1 after a checker, at its opening line", () => {
		hook(
			"pre-commit",
			'node scripts/c.js || {\n  echo "refused" >&2\n  exit 1\n}\n',
		);
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".husky/pre-commit:2.");
	});

	it("passes a block passing the checker's exit code on, and one exiting 1 after its close", () => {
		hook(
			"pre-commit",
			'node scripts/c.js || {\n  rc=$?\n  exit "$rc"\n}\nnode scripts/d.js || {\n  echo x\n}\nexit 1\n',
		);
		const r = run();
		expect(r.status).toBe(0);
	});

	it("FAILs a backslash-continued line at its first line", () => {
		hook("pre-commit", "node scripts/c.js \\\n  --flag || exit 1\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".husky/pre-commit:2.");
	});

	it("FAILs a breach in .husky/pre-commit.local", () => {
		hook("pre-commit.local", "node scripts/check-own.js || exit 1\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(".husky/pre-commit.local:2.");
	});

	it.each([
		[
			"a binary",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell text
			'"${WFC_GITLEAKS:-gitleaks}" git --staged --redact || exit 1',
		],
		["a declared command", 'sh -c "$declared_command" || exit 1'],
		["inline node", "node -e 'process.exit(0)' || exit 1"],
	])("passes %s, an outside command", (_, line) => {
		hook("pre-commit", `${line}\n`);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 pre-commit file(s)");
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
