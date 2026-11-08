// @vitest-environment node
/*
 * Every hook the core registers runs the main checkout's script, never the
 * session's worktree's (#4701, spec #4229 seam 2). The harness hands a
 * worktree session's hooks `CLAUDE_PROJECT_DIR` naming that worktree and
 * `CLAUDE_PLUGIN_ROOT` naming the main checkout's `self-plugin/`, the
 * plugin's in-place home (measured 9 Nov 2026).
 *
 * Break it and a session that edits a hook is judged by its own unlanded
 * edit: a weakened guard lets its author through, a broken one locks it out.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	flattenHooks,
	HOST_SETTINGS,
	MARKER_WRITER,
	SCRIPT_PREFIX,
	SELF_PLUGIN_DIR,
	SELF_PLUGIN_HOOKS,
} from "./lib/core-hooks.js";
import { initGitRepo } from "./lib/git-fixture";

const ROOT = path.resolve(__dirname, "..");
const SID = "aaaaaaaa-1111-2222-3333-444444444444";

const registered = [SELF_PLUGIN_HOOKS, HOST_SETTINGS].flatMap((rel) =>
	flattenHooks(
		JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")).hooks,
	).map((h) => ({ file: rel, command: String(h.command) })),
);

let dir: string;
let main: string;
let worktree: string;

/** Runs `command` as the harness runs a hook of a session in `worktree`. */
function runHook(command: string, input: object) {
	return spawnSync("sh", ["-c", command], {
		cwd: worktree,
		encoding: "utf8",
		input: JSON.stringify({ session_id: SID, ...input }),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: worktree,
			CLAUDE_PLUGIN_ROOT: path.join(main, SELF_PLUGIN_DIR),
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
		},
	});
}

beforeAll(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hook-root-")));
	main = path.join(dir, "main");
	const hooks = path.join(dir, "no-hooks");
	fs.mkdirSync(hooks);
	initGitRepo(main, hooks);
	fs.mkdirSync(path.join(main, SELF_PLUGIN_DIR));
	const libs = fs
		.readdirSync(path.join(ROOT, "scripts", "lib"))
		.filter((f) => f.endsWith(".sh"))
		.map((f) => path.join("scripts", "lib", f));
	for (const rel of [
		path.join("scripts", "self-plugin-canary.sh"),
		path.join("scripts", MARKER_WRITER),
		...libs,
	]) {
		fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), path.join(main, rel));
	}
	spawnSync("git", ["-C", main, "add", "scripts"]);
	spawnSync("git", ["-C", main, "commit", "-qm", "hooks"]);
	worktree = path.join(main, ".claude", "worktrees", "wt");
	spawnSync("git", ["-C", main, "worktree", "add", "-q", worktree]);
	expect(fs.existsSync(path.join(worktree, ".git"))).toBe(true);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("every registered hook command", () => {
	it.each(registered)(
		"$file: $command names its scripts through the main checkout",
		({ command }) => {
			expect(command).not.toMatch(/"?\$\{?CLAUDE_PROJECT_DIR\}?"?\/scripts\//);
			const rest = command
				.replace(SCRIPT_PREFIX, "")
				.replace(
					/"\$\{WFC_GUARD_CODE_DIR:-\$HOME\/\.claude\/\.guard-code\}"\.current\/scripts\/guard-dispatch\.js/,
					"",
				);
			expect(rest).not.toMatch(/scripts\//);
			expect(command).toMatch(SCRIPT_PREFIX);
		},
	);

	/* Both spellings, the self-plugin's and the canary's. */
	const prefixes = [
		...new Set(
			registered.flatMap(({ command }) =>
				[...command.matchAll(SCRIPT_PREFIX)].map((m) => m[0]),
			),
		),
	];

	it("spans both spellings", () => expect(prefixes).toHaveLength(2));

	it.each(prefixes)(
		"%s expands to the main checkout's scripts/ in a worktree session",
		(prefix) => {
			const r = runHook(`printf %s ${prefix}`, {});
			expect(r.status).toBe(0);
			expect(fs.realpathSync(r.stdout)).toBe(path.join(main, "scripts"));
		},
	);
});

describe("an edited hook script in the session's worktree", () => {
	const writer = registered.find(({ command }) =>
		command.includes(MARKER_WRITER),
	);
	const canary = String(
		registered.find(({ file }) => file === HOST_SETTINGS)?.command,
	);
	const bash = {
		hook_event_name: "PreToolUse",
		tool_name: "Bash",
		tool_input: { command: "ls" },
	};

	it("does not change the canary's verdict, either way", () => {
		expect(writer).toBeDefined();
		fs.writeFileSync(
			path.join(worktree, "scripts", "self-plugin-canary.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		fs.writeFileSync(
			path.join(worktree, "scripts", MARKER_WRITER),
			"#!/bin/sh\nexit 0\n",
		);
		const unmarked = runHook(canary, bash);
		expect(unmarked.status).toBe(2);
		expect(unmarked.stderr).toContain("the wfc-self self-plugin did not load");

		const start = runHook(String(writer?.command), {
			hook_event_name: "SessionStart",
			source: "startup",
		});
		expect(start.status).toBe(0);
		fs.writeFileSync(
			path.join(worktree, "scripts", "self-plugin-canary.sh"),
			"#!/bin/sh\necho 'Refused: broken' >&2\nexit 2\n",
		);
		const marked = runHook(canary, bash);
		expect(marked.stderr).toBe("");
		expect(marked.status).toBe(0);
	});
});
