// @vitest-environment node
/*
 * scripts/start-session.sh against real git (#4241): a bare origin carrying
 * `main`, one commit ahead of a main checkout cloned from it, with the real
 * scripts/session-checkout.js cutting. `npm`, `claude` and `reg.exe` are
 * stubs; the `claude` stub records each call's cwd and argv, and its `--bg`
 * prints the recorded promptless launch (lib/bg-launch-fake.ts).
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
import { writeLaunchAnswer } from "./lib/bg-launch-fake";
import { buildBgBranch, writeClaudeStub } from "./lib/claude-stub";
import { writeReg } from "./lib/reg-fake.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "start-session.sh");
const JOB_ID = "ab12cd34";

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

/** The `claude` stub: `--bg` prints the recorded launch of JOB_ID, or,
 * where `bgFault` is given, prints it and exits `faultStatus`. */
const claudeStub = (bgFault?: string, faultStatus = 0) =>
	writeClaudeStub(
		path.join(tmp, "claude"),
		[
			`{ pwd; printf '%s\\n' "$@"; echo; } >> ${shellQuote(calls)}`,
			buildBgBranch({
				...writeLaunchAnswer(tmp, JOB_ID, "idle"),
				onLaunch:
					bgFault === undefined
						? ""
						: `printf '%s\\n' ${shellQuote(bgFault)}; exit ${faultStatus}`,
			}),
		],
		7,
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
		claude: claudeStub(),
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
	git(main, "push", "-q", "origin", "HEAD:main");
	fs.writeFileSync(path.join(main, "landed.txt"), "x");
	git(main, "add", "-A");
	git(main, "commit", "-qm", "landed");
	git(main, "push", "-q", "origin", "HEAD:main");
	git(main, "reset", "-q", "--hard", "HEAD~1");
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("starts a job in a worktree cut at origin/main, named for the session, and attaches to it", () => {
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
		[dir, "attach", JOB_ID],
	]);
	expect(git(dir, "rev-parse", "HEAD")).toBe(
		git(main, "rev-parse", "origin/main"),
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
