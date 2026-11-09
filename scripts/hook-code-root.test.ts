// @vitest-environment node
/*
 * Every hook the core registers runs the main checkout's script, never the
 * session's worktree's (#4701, spec #4229 seam 2). The harness hands a
 * worktree session's hooks `CLAUDE_PROJECT_DIR` naming that worktree and
 * `CLAUDE_PLUGIN_ROOT` naming the main checkout's `self-plugin/`.
 *
 * Break it and a session that edits a hook is judged by its own unlanded
 * edit: a weakened guard lets its author through, a broken one locks it out.
 *
 * It also pins the canary line's own registration, its type, onFailure and
 * timeout, which the harness reads from the session's worktree (#4745).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CANARY_COMMAND,
	flattenHooks,
	MARKER_WRITER,
	SCRIPT_PREFIX,
	SELF_PLUGIN_DIR,
} from "./lib/core-hooks.js";
import { CANARY_MAIN_SCRIPTS, MAIN_SCRIPTS } from "./lib/core-hooks-testkit";
import { initGitRepo } from "./lib/git-fixture";
import { shellQuote } from "./lib/sh-quote.js";

const ROOT = path.resolve(__dirname, "..");
const SID = "aaaaaaaa-1111-2222-3333-444444444444";

const SETTINGS = ".claude/settings.json";
const registered = [
	{
		file: "self-plugin/hooks/hooks.json",
		text: fs.readFileSync(
			path.join(ROOT, "self-plugin/hooks/hooks.json"),
			"utf8",
		),
	},
	{
		file: SETTINGS,
		text: fs.readFileSync(path.join(ROOT, ".claude/settings.json"), "utf8"),
	},
].flatMap(({ file, text }) =>
	flattenHooks(JSON.parse(text).hooks).map((h) => ({
		...h,
		file,
		command: String(h.command),
	})),
);
const COPIED = [
	"scripts/self-plugin-canary.sh",
	"scripts/write-self-plugin-marker.sh",
];

let dir: string;
let main: string;

function cutWorktree(name: string) {
	const at = path.join(main, ".claude", "worktrees", name);
	spawnSync("git", ["-C", main, "worktree", "add", "-q", "--detach", at]);
	expect(fs.existsSync(path.join(at, ".git"))).toBe(true);
	return at;
}

function runHook(worktree: string, command: string, input: object) {
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
	for (const rel of [...COPIED, ...libs]) {
		fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
		fs.copyFileSync(path.join(ROOT, rel), path.join(main, rel));
	}
	spawnSync("git", ["-C", main, "add", "scripts"]);
	spawnSync("git", ["-C", main, "commit", "-qm", "hooks"]);
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

	const prefixes = [
		...new Set(
			registered.flatMap(({ command }) =>
				[...command.matchAll(SCRIPT_PREFIX)].map((m) => m[0]),
			),
		),
	];

	it("spans both spellings", () =>
		expect(prefixes.sort()).toEqual(
			[CANARY_MAIN_SCRIPTS, MAIN_SCRIPTS].sort(),
		));

	it.each(prefixes)(
		"%s expands to the main checkout's scripts/ in a worktree session",
		(prefix) => {
			const r = runHook(cutWorktree("read"), `printf %s ${prefix}`, {});
			expect(r.status).toBe(0);
			expect(fs.realpathSync(r.stdout)).toBe(path.join(main, "scripts"));
		},
	);
});

const canaryLine = registered.find(
	({ file, command }) => file === SETTINGS && command === CANARY_COMMAND,
);
const canary = String(canaryLine?.command);
const writer = registered.find(({ command }) =>
	command.includes(MARKER_WRITER),
);
const bash = {
	hook_event_name: "PreToolUse",
	tool_name: "Bash",
	tool_input: { command: "ls" },
};
const sessionStart = { hook_event_name: "SessionStart", source: "startup" };

describe("an edited hook script in the session's worktree (#4701)", () => {
	it("does not change the canary's verdict, either way (#4701)", () => {
		expect(writer).toBeDefined();
		const worktree = cutWorktree("edited");
		fs.writeFileSync(
			path.join(worktree, "scripts", "self-plugin-canary.sh"),
			"#!/bin/sh\nexit 0\n",
		);
		fs.writeFileSync(
			path.join(worktree, "scripts", MARKER_WRITER),
			"#!/bin/sh\nexit 0\n",
		);
		const unmarked = runHook(worktree, canary, bash);
		expect(unmarked.status).toBe(2);
		expect(unmarked.stderr).toContain("the wfc-self self-plugin did not load");
		expect(unmarked.stderr).toContain(
			`\n! claude plugin marketplace add ${shellQuote(`${main}/self-plugin`)} --scope user\n`,
		);

		const start = runHook(worktree, String(writer?.command), sessionStart);
		expect(start.status).toBe(0);
		fs.writeFileSync(
			path.join(worktree, "scripts", "self-plugin-canary.sh"),
			"#!/bin/sh\necho 'Refused: broken' >&2\nexit 2\n",
		);
		const marked = runHook(worktree, canary, bash);
		expect(marked.stderr).toBe("");
		expect(marked.status).toBe(0);
	});
});

/* The worktree's own `.claude/settings.json` is the canary line the harness
 * runs, and a session is cut only from `origin/main`, which only the lander
 * moves, on this whole suite green. So a canary line that cannot reach both
 * verdicts in time fails here, before any session reads it (#4745). */
describe("the canary registration the harness reads", () => {
	it("is a command hook that reaches both verdicts inside its timeout (#4745)", () => {
		expect(canaryLine).toMatchObject({
			type: "command",
			onFailure: "block",
			timeout: expect.any(Number),
		});
		const worktree = cutWorktree("timed");
		/* Wall-clock, as the harness kills the hook at its registered timeout
		 * and the line runs in `sh`, where no clock seam reaches. */
		const timed = () => {
			const at = performance.now();
			const r = runHook(worktree, canary, bash);
			return { ...r, ms: performance.now() - at };
		};
		const refused = timed();
		runHook(worktree, String(writer?.command), sessionStart);
		const allowed = timed();
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain("the wfc-self self-plugin did not load");
		expect(allowed.status).toBe(0);
		expect(allowed.stderr).toBe("");
		expect(Math.max(refused.ms, allowed.ms)).toBeLessThan(
			Number(canaryLine?.timeout) * 1000,
		);
	});
});
