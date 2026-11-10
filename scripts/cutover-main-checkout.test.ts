// @vitest-environment node
/*
 * cutover-main-checkout.js's boundary set (§X11, #4346): each exit, argv, a
 * directory no main checkout holds, and the adapters its shell wires crossed
 * for real — the session listing through a `claude` stand-in at
 * WFC_CLAUDE_BIN, the cut through an `npm` stand-in at WFC_NPM, the land
 * pushing to a bare origin, git in a temporary directory. Its branches are
 * lib/cutover.test.ts's.
 *
 * Loosen it and the program reports a cutover it did not make, exits 0 on a
 * refusal, or wires an adapter that never reaches git or the listing.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "cutover-main-checkout.js");

let tmp: string;
let origin: string;
let main: string;
let config: string;
let landerHolder: ReturnType<typeof spawn> | undefined;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const commitIn = (cwd: string, files: Record<string, string>, msg: string) => {
	for (const [name, text] of Object.entries(files))
		fs.writeFileSync(path.join(cwd, name), text);
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", msg);
	return git(cwd, "rev-parse", "HEAD");
};

/** The listing `claude agents --json` answers. */
const listAgents = (records: object[]) => {
	const bin = path.join(config, "bin", "claude");
	const body = JSON.stringify(records);
	fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`);
	fs.chmodSync(bin, 0o755);
};

/** One session, in `cwd`. */
const listSessionIn = (cwd: string) =>
	listAgents([{ name: "live", sessionId: "s-1", cwd }]);

const run = (cwd: string, ...args: string[]) => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_PROJECT_DIR: main,
		CLAUDE_CONFIG_DIR: config,
		WFC_CLAUDE_CONFIG_A: config,
		WFC_CLAUDE_CONFIG_B: config,
		WFC_CLAUDE_CONFIG_C: config,
		WFC_CLAUDE_BIN: path.join(config, "bin", "claude"),
		WFC_NPM: path.join(tmp, "npm"),
		WFC_MODULES: "landing",
	};
	delete env.CLAUDE_CODE_SESSION_ID;
	return runInProcess(SCRIPT, args, { cwd, env });
};

const upstream = () =>
	execFileSync("git", ["config", "--get", "branch.main.merge"], {
		cwd: main,
		encoding: "utf8",
		stdio: "pipe",
	}).trim();

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cutover-")));
	origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	config = path.join(tmp, "config");
	fs.mkdirSync(path.join(config, "bin"), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, "npm"),
		"#!/bin/sh\nmkdir node_modules && cp package-lock.json node_modules/lock\n",
	);
	fs.chmodSync(path.join(tmp, "npm"), 0o755);
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	commitIn(
		main,
		{ ".gitignore": ".claude/\n", "a.md": "a\n", "package-lock.json": "{}\n" },
		"seed",
	);
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(main, "branch", "-q", "--set-upstream-to=origin/landing", "main");
	/* A live process whose command line names queue-lander.js holds the lander's
	 * lock, so the land's lander start finds one running. */
	landerHolder = spawn("sh", ["-c", "sleep 60", "queue-lander.js"], {
		stdio: "ignore",
	});
	const markers = path.join(main, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	fs.writeFileSync(path.join(markers, ".lander.pid"), `${landerHolder.pid}\n`);
});

afterEach(() => {
	landerHolder?.kill();
	execFileSync("chmod", ["-R", "u+w", tmp]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("exits 0 having pushed main's local commit to a queue ref, named the edit left and removed the upstream", () => {
	const own = commitIn(main, { "local.md": "mine\n" }, "local only");
	fs.writeFileSync(path.join(main, "a.md"), "edited\n");
	listSessionIn(tmp);

	const r = run(main);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("the main checkout is cut over");
	expect(r.stderr).toContain("pushed main's 1 local commit(s)");
	expect(r.stderr).toContain("1 edit(s) remain in the main checkout");
	expect(r.stderr).toContain("  a.md — ");
	git(main, "fetch", "-q", "origin");
	git(
		main,
		"merge-base",
		"--is-ancestor",
		own,
		`origin/queue/cutover-main-${own.slice(0, 9)}`,
	);
	expect(() => upstream()).toThrow();
});

it("cuts over, run outside a session, while the listing names no session at all (#4743)", () => {
	listAgents([]);

	const r = run(main);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("the main checkout is cut over");
	expect(() => upstream()).toThrow();
});

it("exits 1, cutting nothing over, while the listing puts a session in the main checkout", () => {
	listSessionIn(main);

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("1 session(s) still stand in the main checkout");
	expect(r.stderr).toContain("  live");
	expect(upstream()).toBe("refs/heads/landing");
});

it("exits 1 naming the git that failed", () => {
	listSessionIn(tmp);
	git(main, "remote", "set-url", "origin", path.join(tmp, "gone.git"));

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(
		/^cutover: failed: git fetch --quiet origin main failed in /,
	);
	expect(upstream()).toBe("refs/heads/landing");
});

it("exits 1 from a directory no main checkout holds", () => {
	const r = run(tmp);

	expect(r.status).toBe(1);
	expect(r.stderr).toBe("cutover: no main checkout holds this directory\n");
});

it("exits 2 on an argument it does not take", () => {
	const r = run(main, "--now");

	expect(r.status).toBe(2);
	expect(r.stderr).toContain("usage: node scripts/cutover-main-checkout.js");
	expect(upstream()).toBe("refs/heads/landing");
});

it("cuts over the main checkout from a linked worktree of it", () => {
	listSessionIn(tmp);
	const linked = path.join(tmp, "linked");
	git(main, "worktree", "add", "-q", "--detach", linked);

	const r = run(linked);

	expect(r.status, r.stderr).toBe(0);
	expect(() => upstream()).toThrow();
});
