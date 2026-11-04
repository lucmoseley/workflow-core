// @vitest-environment node
/*
 * scripts/start-session.sh against real git (#4241): a bare origin carrying
 * `main` and `landing` and a main checkout cloned from it, with the real
 * scripts/session-checkout.js cutting. `npm`, `claude` and `reg.exe` are
 * stubs; the `claude` stub records each call's cwd and argv, and its `--bg`
 * prints what the real one does (measured 4 Nov 2026, #4241).
 *
 * spawn-kept: a shell script, which run-in-process cannot load.
 *
 * Loosen it and a hand-started session opens in the main checkout, in a
 * worktree no dispatched session would have, or as no job at all.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeReg } from "./lib/reg-fake.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "start-session.sh");
const BG_OUT =
	"backgrounded · \u001b[36mab12cd34\u001b[39m · a-name (idle — send a prompt to start)";

let tmp: string;
let main: string;
let calls: string;
let stubs: Record<string, string>;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const stub = (name: string, body: string) => {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, `#!/bin/bash\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
};

const claudeStub = (bgOut: string, bgStatus = 0) =>
	stub(
		"claude",
		[
			`{ pwd; printf '%s\\n' "$@"; echo; } >> ${shellQuote(calls)}`,
			`if [[ "$1" == --bg ]]; then printf '%s\\n' ${shellQuote(bgOut)}; exit ${bgStatus}; fi`,
			"exit 7",
		].join("\n"),
	);

const run = (args: string[], env: Record<string, string> = {}) =>
	spawnSync("bash", [SCRIPT, ...args], {
		cwd: main,
		encoding: "utf8",
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: main,
			WFC_NPM: stubs.npm,
			WFC_CLAUDE_BIN: stubs.claude,
			CLAUDE_INTEROP_REG: path.join(tmp, "no-reg"),
			...env,
		},
	});

/** Each `claude` call as [cwd, ...argv], or [] where none was made. */
const readCalls = () =>
	fs.existsSync(calls)
		? fs
				.readFileSync(calls, "utf8")
				.split("\n\n")
				.filter(Boolean)
				.map((call) => call.split("\n"))
		: [];

const worktree = (name: string) =>
	path.join(main, ".claude", "worktrees", name);

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-")));
	const origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	calls = path.join(tmp, "calls");
	stubs = {
		npm: stub("npm", "mkdir node_modules"),
		claude: claudeStub(BG_OUT),
	};
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	for (const [name, text] of Object.entries({
		".gitignore": "/node_modules\n.claude/worktrees/\n",
		"package.json": "{}\n",
		"package-lock.json": "lock\n",
	}))
		fs.writeFileSync(path.join(main, name), text);
	git(main, "add", "-A");
	git(main, "commit", "-qm", "seed");
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	fs.writeFileSync(path.join(main, "landed.txt"), "x");
	git(main, "add", "-A");
	git(main, "commit", "-qm", "landed");
	git(main, "push", "-q", "origin", "HEAD:landing");
	git(main, "reset", "-q", "--hard", "origin/main");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("starts a job in a worktree cut at origin/landing, named for the session, and attaches to it", () => {
	const r = run(["brisk-otter", "--model", "opus"]);

	expect(r.status, r.stderr).toBe(7);
	const dir = worktree("brisk-otter");
	expect(readCalls()).toEqual([
		[
			dir,
			"--bg",
			"--agent",
			"claude",
			"--name",
			"brisk-otter",
			"--model",
			"opus",
		],
		[dir, "attach", "ab12cd34"],
	]);
	expect(git(dir, "rev-parse", "HEAD")).toBe(
		git(main, "rev-parse", "origin/landing"),
	);
});

it("names the session hand-<UTC timestamp> where the first argument is a flag", () => {
	const r = run(["--model", "opus"]);

	expect(r.status, r.stderr).toBe(7);
	const [[cwd, ...argv]] = readCalls();
	const name = argv[4];
	expect(name).toMatch(/^hand-\d{8}-\d{6}$/);
	expect(cwd).toBe(worktree(name));
	expect(argv).toEqual([
		"--bg",
		"--agent",
		"claude",
		"--name",
		name,
		"--model",
		"opus",
	]);
});

it("exits 1 without starting claude when the cut refuses", () => {
	const r = run([".dotted"]);

	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/^session checkout: .*\.dotted/);
	expect(readCalls()).toEqual([]);
});

it("exits 1 naming the cut worktree when the launch fails, and attaches nothing", () => {
	stubs.claude = claudeStub("Workspace not trusted.", 1);

	const r = run(["brisk-otter"]);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(`failed in ${worktree("brisk-otter")}`);
	expect(r.stderr).toContain("Workspace not trusted.");
	expect(readCalls()).toHaveLength(1);
});

it("exits 1 pointing at the agents view when the launch prints no job id", () => {
	stubs.claude = claudeStub("backgrounded");

	const r = run(["brisk-otter"]);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("attach from `claude agents`");
	expect(readCalls()).toHaveLength(1);
});

/* Crosses the real clock: the probe's wedge is `timeout` expiring, at its 1 s floor. */
it("exits 5 on a wedged interop bridge before cutting anything", () => {
	const r = run(["brisk-otter"], {
		CLAUDE_INTEROP_REG: writeReg(tmp, [30]),
		CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		CLAUDE_INTEROP_PROBE_ATTEMPTS: "1",
	});

	expect(r.status).toBe(5);
	expect(r.stderr).toContain("REFUSED: the WSL interop bridge is wedged");
	expect(r.stderr).toContain("wsl --shutdown");
	expect(fs.existsSync(worktree("brisk-otter"))).toBe(false);
	expect(readCalls()).toEqual([]);
});
