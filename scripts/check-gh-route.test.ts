// @vitest-environment node
/*
 * Pins check-gh-route.js's boundary set (base §X11): each exit, argv and
 * --index, and the real tree and shell-file reads. Which shapes reach `gh` or
 * `claude` off its one route is lib/gh-route.test.ts's (#3455, #3559, #4652).
 *
 * Fabricated files in a throwaway directory, never this checkout, so a case's
 * findings are only its own. The Node bodies live in lib/fixtures/gh-route/ as
 * `.txt`, which the checker never reads, so this file holds no breach of its
 * own.
 *
 * .husky/pre-commit refuses on this checker, so loosening a case here lets a
 * `gh` or `claude` call escape every test's stub and reach the live tracker or
 * the live sessions.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-gh-route.js");

let root: string;

const file = (rel: string, body: string) => {
	const at = path.join(root, rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, body);
};

const FIXTURE = {
	"env-read.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/env-read.js.txt",
	),
	"literal-spawn.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/literal-spawn.js.txt",
	),
	"on-primitive.js.txt": path.join(
		__dirname,
		"lib/fixtures/gh-route/on-primitive.js.txt",
	),
};

const fixture = (rel: string, name: keyof typeof FIXTURE) =>
	file(rel, fs.readFileSync(FIXTURE[name], "utf8"));

/** Runs the checker in `root`, its host root `home`. */
const runFrom = (home: string, args: string[]) => {
	const r = runInProcess(SCRIPT, args, {
		cwd: root,
		env: { ...process.env, GITHUB_ACTIONS: "", CLAUDE_PROJECT_DIR: home },
	});
	return { status: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

const run = (...args: string[]) => runFrom(root, args);

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "gh-route-"));
	// shellFiles() asks git which files are vendored.
	execFileSync("git", ["init", "-q"], { cwd: root });
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("check-gh-route", () => {
	it("FAILs a local copy of the spawn, naming file, line, lib/gh.js and its exemplar", () => {
		fixture("scripts/arm.js", "env-read.js.txt");
		fixture("scripts/lib/spawn.js", "literal-spawn.js.txt");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain("FAIL: 2 second binary route(s)");
		expect(r.out).toContain(
			"2 second binary route(s): scripts/arm.js:2, scripts/lib/spawn.js:1.",
		);
		expect(r.out).toContain(
			"Fix: call `gh`, `ghJson` or their kin from scripts/lib/gh.js, as scripts/check-issue-orphans.js does.",
		);
	});

	it("FAILs a pre-commit hook, its local half and an extensionless shell script running a bare gh", () => {
		file(".husky/pre-commit", "#!/bin/sh\ngh auth status || exit 1\n");
		file(".husky/pre-commit.local", "#!/bin/sh\ngh auth status || exit 1\n");
		file("scripts/lib/tool", "#!/usr/bin/env bash\ngh auth status\n");
		const r = run();
		expect(r.status).toBe(1);
		expect(r.out).toContain(
			"3 second binary route(s): .husky/pre-commit:2, .husky/pre-commit.local:2, scripts/lib/tool:2.",
		);
		expect(r.out).toContain(`Fix: run "\${WFC_GH:-gh}"`);
	});

	it("passes a tree on the one route, counting the files it read", () => {
		fixture("scripts/on.js", "on-primitive.js.txt");
		file(
			"scripts/hook.sh",
			`#!/usr/bin/env bash\n"\${WFC_GH:-gh}" issue view 7\n`,
		);
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"OK: 2 file(s), every `gh` call on WFC_GH and every `claude` call on WFC_CLAUDE_BIN.",
		);
	});

	it("exits 2 on an unknown flag, naming it and the usage", () => {
		const r = run("--bogus");
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN: unknown flag: --bogus");
		expect(r.out).toContain(
			"usage: node check-gh-route.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
		);
	});
});

describe("--index (#3687)", () => {
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "pipe" });
	const bare = "#!/usr/bin/env bash\ngh issue list\n";

	beforeEach(() => {
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		file(
			"scripts/hook.sh",
			`#!/usr/bin/env bash\n"\${WFC_GH:-gh}" issue list\n`,
		);
		git("add", ".");
		git("commit", "-qm", "seed");
	});

	it("passes a bare `gh` in an untracked shell file and in an unstaged edit", () => {
		file(".husky/loose.sh", bare);
		file("scripts/hook.sh", bare);
		expect(run().status).toBe(1);
		const r = run("--index");
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK: 1 file(s)");
	});

	it("refuses the same `gh` once staged, naming its file and line", () => {
		file(".husky/loose.sh", bare);
		git("add", ".husky/loose.sh");
		const r = run("--index", "--json");
		expect(r.status).toBe(1);
		expect(JSON.parse(r.out).findings).toMatchObject([
			{ tag: "SHELL-BARE", file: ".husky/loose.sh", line: 2 },
		]);
		expect(JSON.parse(r.out).findings[0].message).toContain(
			`Fix: run "\${WFC_GH:-gh}"`,
		);
	});

	it("reports a staged bare `gh` as WARN under --warn, exiting 0", () => {
		file("scripts/hook.sh", bare);
		const r = run("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("1 second binary route(s): scripts/hook.sh:2.");
		expect(r.out).toContain("WARN: 1 second binary route(s)");
	});

	it("refuses a bare `gh` a commit adds under --against, and passes one its base already holds", () => {
		file("scripts/hook.sh", bare);
		git("commit", "-qam", "bare");
		const added = run("--against", "HEAD~1");
		expect(added.status).toBe(1);
		expect(added.out).toContain("NOT in HEAD~1 — this commit adds them");
		const inherited = run("--against", "HEAD");
		expect(inherited.status).toBe(0);
		expect(inherited.out).toContain("already in HEAD");
	});

	it("judges the tree --root names over the host root", () => {
		file("scripts/hook.sh", bare);
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "gh-route-home-"));
		try {
			expect(runFrom(elsewhere, []).out).toContain("OK: 0 file(s)");
			const r = runFrom(elsewhere, ["--root", root]);
			expect(r.status).toBe(1);
			expect(r.out).toContain("1 second binary route(s): scripts/hook.sh:2.");
		} finally {
			fs.rmSync(elsewhere, { recursive: true, force: true });
		}
	});
});
