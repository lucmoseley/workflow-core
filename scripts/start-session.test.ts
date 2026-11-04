// @vitest-environment node
/*
 * scripts/start-session.sh against real git (#4241): a bare origin carrying
 * `main` and `landing` and a main checkout cloned from it, with the real
 * scripts/session-checkout.js cutting. `claude` and `npm` are stubs; the
 * `claude` stub records its cwd and argv.
 *
 * spawn-kept: a shell script, which run-in-process cannot load.
 *
 * Loosen it and a hand-started session opens in the main checkout, or in a
 * worktree no dispatched session would have.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "start-session.sh");

let tmp: string;
let main: string;
let seen: string;
let stubs: Record<string, string>;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const stub = (name: string, body: string) => {
	const file = path.join(tmp, name);
	fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
	fs.chmodSync(file, 0o755);
	return file;
};

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

const opened = () =>
	fs.existsSync(seen) ? fs.readFileSync(seen, "utf8").split("\n") : null;

const worktree = (name: string) =>
	path.join(main, ".claude", "worktrees", name);

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "start-")));
	const origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	seen = path.join(tmp, "seen");
	stubs = {
		npm: stub("npm", "mkdir node_modules"),
		claude: stub(
			"claude",
			`{ pwd; printf '%s\\n' "$@"; } > ${shellQuote(seen)}; exit 7`,
		),
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

it("opens claude in a worktree cut at origin/landing, named for the session, passing its arguments on", () => {
	const r = run(["brisk-otter", "--model", "opus"]);

	expect(r.status, r.stderr).toBe(7);
	const dir = worktree("brisk-otter");
	expect(opened()).toEqual([
		dir,
		"--name",
		"brisk-otter",
		"--model",
		"opus",
		"",
	]);
	expect(git(dir, "rev-parse", "HEAD")).toBe(
		git(main, "rev-parse", "origin/landing"),
	);
});

it("names the session hand-<UTC timestamp> where the first argument is a flag", () => {
	const r = run(["--model", "opus"]);

	expect(r.status, r.stderr).toBe(7);
	const [cwd, flag, name, ...rest] = opened() ?? [];
	expect(name).toMatch(/^hand-\d{8}-\d{6}$/);
	expect(cwd).toBe(worktree(name));
	expect([flag, ...rest]).toEqual(["--name", "--model", "opus", ""]);
});

it("exits 1 without opening claude when the cut refuses", () => {
	const r = run([".dotted"]);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("session checkout:");
	expect(opened()).toBeNull();
});

/* Crosses the real clock: the probe's wedge is `timeout` expiring, at its 1 s floor. */
it("exits 5 on a wedged interop bridge before cutting anything", () => {
	const r = run(["brisk-otter"], {
		CLAUDE_INTEROP_REG: stub("reg", "exec sleep 30"),
		CLAUDE_INTEROP_PROBE_TIMEOUT: "1",
		CLAUDE_INTEROP_PROBE_ATTEMPTS: "1",
	});

	expect(r.status).toBe(5);
	expect(r.stderr).toContain("REFUSED: the WSL interop bridge is wedged");
	expect(fs.existsSync(worktree("brisk-otter"))).toBe(false);
	expect(opened()).toBeNull();
});
