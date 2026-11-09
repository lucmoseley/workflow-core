// @vitest-environment node
/*
 * The levelling step (#4238) against real git: a bare origin carrying `main`
 * and `landing`, a main checkout cloned from it with a linked worktree, and a
 * second clone that moves `origin/main` as the lander would. `npm` is a stub
 * at `WFC_NPM` that records each install.
 *
 * Loosen it and the main checkout's `main` drifts from the lander-green tip,
 * a local commit or a session's edit is moved or lost, two passes install at
 * once, or hook code runs against a tree built for another lockfile.
 */
import {
	type ChildProcess,
	execFileSync,
	spawn,
	spawnSync,
} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { level, renderOutcome } from "./lib/level-main.js";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "level-main.js");
const REPO = path.resolve(__dirname, "..");
const MARKER_LIB = "scripts/lib/self-plugin-marker.sh";
/* The canary, its writer and every file they source. */
const CANARY_FILES = [
	"scripts/self-plugin-canary.sh",
	"scripts/write-self-plugin-marker.sh",
	MARKER_LIB,
	"scripts/lib/marker-root.sh",
	"scripts/lib/guard-root.sh",
	"scripts/lib/guard-log.sh",
	"scripts/lib/script-path.sh",
];
const HOUR = 3_600_000;

let tmp: string;
let origin: string;
let main: string;
let worktree: string;
let lander: string;
let npmCalls: string;
let npmStub: string;
let sleeper: ChildProcess | null;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitIn = (
	cwd: string,
	files: Record<string, string>,
	message: string,
) => {
	for (const [name, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
		fs.writeFileSync(path.join(cwd, name), text);
	}
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", message);
	return git(cwd, "rev-parse", "HEAD");
};

const landOnMain = (files: Record<string, string>) => {
	const sha = commitIn(lander, files, "lander-green");
	git(lander, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	return sha;
};

const installs = () =>
	fs.existsSync(npmCalls)
		? fs.readFileSync(npmCalls, "utf8").trim().split("\n")
		: [];

const stubCi = (dir: string) =>
	execFileSync(npmStub, ["ci"], { cwd: dir, stdio: "ignore" });

const pass = (opts: Partial<Parameters<typeof level>[1]> = {}) =>
	level(main, { install: stubCi, now: Date.now(), ...opts });

const run = (cwd: string, ...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd,
		env: { ...process.env, WFC_NPM: npmStub },
	});

const builtLock = () =>
	fs.readFileSync(path.join(main, "node_modules", "lock"), "utf8");

beforeEach(() => {
	sleeper = null;
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "level-")));
	origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	worktree = path.join(tmp, "session");
	lander = path.join(tmp, "lander");
	npmCalls = path.join(tmp, "npm-calls");
	npmStub = path.join(tmp, "npm");
	fs.writeFileSync(
		npmStub,
		`#!/bin/sh\nmkdir node_modules && cp package-lock.json node_modules/lock && pwd >> ${shellQuote(npmCalls)}\n`,
	);
	fs.chmodSync(npmStub, 0o755);
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	git(main, "config", "user.email", "t@t");
	git(main, "config", "user.name", "t");
	commitIn(
		main,
		{
			".gitignore": "/node_modules\n",
			"package.json": "{}\n",
			"package-lock.json": "lock-1\n",
			"hook.js": "v1\n",
			"gone.js": "x\n",
			"staged.js": "x\n",
		},
		"seed",
	);
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	git(main, "worktree", "add", "-q", "--detach", worktree, "origin/main");
	git(tmp, "clone", "-q", origin, lander);
	git(lander, "config", "user.email", "t@t");
	git(lander, "config", "user.name", "t");
	/* The main checkout's tree as a pass leaves it for lock-1. */
	expect(pass().install.installed).toBe(true);
	fs.rmSync(npmCalls, { force: true });
});

afterEach(() => {
	sleeper?.kill();
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("fast-forwards main to a freshly fetched origin/main, run from a session's worktree", () => {
	expect(pass()).toMatchObject({ status: "level", fetchError: null });

	const green = landOnMain({ "hook.js": "v2\n" });
	const r = run(worktree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toMatch(/^levelling \S+\nmain fast-forwarded/m);
	expect(git(main, "rev-parse", "HEAD")).toBe(green);
	expect(git(main, "symbolic-ref", "--short", "HEAD")).toBe("main");
	expect(git(worktree, "rev-parse", "HEAD")).not.toBe(green);
	expect(installs()).toEqual([]);
});

it("follows origin/main, never origin/landing", () => {
	const green = landOnMain({ "hook.js": "v2\n" });
	commitIn(lander, { "hook.js": "v3-untested\n" }, "landing only");
	git(lander, "push", "-q", "origin", "HEAD:landing");

	expect(pass()).toMatchObject({ status: "forwarded", head: green });
	expect(git(main, "rev-parse", "HEAD")).toBe(green);
});

it("rebuilds node_modules through npm when a fast-forward changes the lockfile, staging nothing in the work tree", () => {
	landOnMain({ "package-lock.json": "lock-2\n" });

	const r = run(main);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("node_modules rebuilt");
	expect(installs()).toHaveLength(1);
	expect(builtLock()).toBe("lock-2\n");
	expect(git(main, "status", "--porcelain", "-uall")).toBe("");
	expect(fs.existsSync(path.join(main, ".git", "wfc-level"))).toBe(false);

	expect(run(main).status).toBe(0);
	expect(installs()).toHaveLength(1);
});

it("keeps the old tree where npm fails, and retries on the next pass", () => {
	landOnMain({ "package-lock.json": "lock-2\n" });
	const good = fs.readFileSync(npmStub, "utf8");
	fs.writeFileSync(npmStub, "#!/bin/sh\nexit 7\n");

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("npm ci exited 7");
	expect(r.stderr).toContain("the next pass retries it");
	expect(git(main, "rev-parse", "HEAD")).toBe(
		git(main, "rev-parse", "origin/main"),
	);
	expect(builtLock()).toBe("lock-1\n");

	fs.writeFileSync(npmStub, good);
	expect(pass()).toMatchObject({
		status: "level",
		install: { installed: true },
	});
	expect(builtLock()).toBe("lock-2\n");
});

it("installs HEAD's lockfile, never an uncommitted edit of it", () => {
	fs.writeFileSync(path.join(main, "package-lock.json"), "stray\n");

	expect(pass().install.installed).toBe(false);

	fs.rmSync(path.join(main, "node_modules"), { recursive: true });
	expect(pass().install.installed).toBe(true);
	expect(builtLock()).toBe("lock-1\n");
});

it("refuses a fast-forward over edits, naming each blocking file with its age and last writer", () => {
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({
		"hook.js": "v2\n",
		"fresh.js": "new\n",
		"gone.js": "y\n",
		"staged.js": "y\n",
		"dir/inner.js": "z\n",
		"free.js": "x\n",
	});
	const now = Date.now();
	fs.writeFileSync(path.join(main, "hook.js"), "half-written\n");
	const old = (now - 3 * HOUR) / 1000;
	fs.utimesSync(path.join(main, "hook.js"), old, old);
	fs.writeFileSync(path.join(main, "fresh.js"), "untracked clash\n");
	fs.rmSync(path.join(main, "gone.js"));
	fs.writeFileSync(path.join(main, "staged.js"), "staged\n");
	git(main, "add", "staged.js");
	fs.writeFileSync(path.join(main, "dir"), "a file where a directory lands\n");
	fs.writeFileSync(path.join(main, "elsewhere.txt"), "no clash\n");

	const o = pass({
		now,
		lastWriter: (rel) =>
			rel === "hook.js" ? { sessionId: "sess-a", at: now - 2 * HOUR } : null,
	});

	expect(o.status).toBe("blocked");
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
	expect(fs.readFileSync(path.join(main, "hook.js"), "utf8")).toBe(
		"half-written\n",
	);
	const lines = renderOutcome(o, now);
	expect(lines[0]).toContain("refused: 5 edit(s)");
	expect(lines[0]).toContain("move each to its session's own worktree");
	const unknown = "last writer unknown — no surviving write ledger names it";
	expect(lines.slice(1)).toEqual([
		expect.stringMatching(new RegExp(`^ {2}dir — 0m old; ${unknown}$`)),
		expect.stringMatching(new RegExp(`^ {2}fresh\\.js — 0m old; ${unknown}$`)),
		`  gone.js — deleted; ${unknown}`,
		"  hook.js — 3h old; last writer session sess-a, ledger written 2h ago",
		expect.stringMatching(new RegExp(`^ {2}staged\\.js — 0m old; ${unknown}$`)),
	]);
});

it("fast-forwards past edits on paths origin/main does not change", () => {
	const green = landOnMain({ "hook.js": "v2\n" });
	fs.writeFileSync(path.join(main, "package.json"), '{"edited":true}\n');

	expect(pass()).toMatchObject({ status: "forwarded", head: green });
	expect(fs.readFileSync(path.join(main, "package.json"), "utf8")).toBe(
		'{"edited":true}\n',
	);
});

it("refuses where main carries a commit of its own, naming it and the way out", () => {
	const own = commitIn(main, { "local.txt": "mine\n" }, "local only");
	landOnMain({ "hook.js": "v2\n" });

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"main carries 1 commit(s) on neither origin/main nor a queue ref",
	);
	expect(r.stderr).toContain("land them from a session worktree");
	expect(r.stderr).toContain(own.slice(0, 9));
	expect(git(main, "rev-parse", "HEAD")).toBe(own);
	expect(installs()).toEqual([]);
});

it("waits where main's own commits are all on a queue ref, for the lander to take them", () => {
	commitIn(main, { "local.txt": "mine\n" }, "local only");
	git(main, "push", "-q", "origin", "HEAD:refs/heads/queue/cutover");
	git(main, "fetch", "-q", "origin");

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"waiting: main carries 1 commit(s) not yet on origin/main, all on a queue ref",
	);
});

it("refuses a main checkout not yet cut over, its main tracking landing (#4248)", () => {
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({ "hook.js": "v2\n" });
	git(main, "config", "branch.main.merge", "refs/heads/landing");

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("has not been cut over");
	expect(r.stderr).toContain("cutover-main-checkout.js");
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
	expect(run(main, "--quiet").stderr).toBe("");
});

it("prints nothing under --quiet where main was already level", () => {
	const r = run(main, "--quiet");
	expect(r.status).toBe(0);
	expect(r.stderr).toBe("");
	landOnMain({ "hook.js": "v2\n" });
	expect(run(main, "--quiet").stderr).toContain("main fast-forwarded");
});

it("refuses where the main checkout is off main", () => {
	landOnMain({ "hook.js": "v2\n" });
	git(main, "checkout", "-q", "--detach");

	const o = pass();

	expect(o).toMatchObject({ status: "off-branch", branch: null });
	expect(renderOutcome(o, Date.now())[0]).toContain(
		"on a detached HEAD, not main, so main was not moved — switch it back to main",
	);
});

it("reports git's own refusal where the fast-forward fails for a reason no edit explains", () => {
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({ "hook.js": "v2\n" });
	fs.writeFileSync(path.join(main, ".git", "index.lock"), "");

	const o = pass();

	expect(o.status).toBe("refused");
	expect(renderOutcome(o, Date.now())[0]).toMatch(
		/^refused: git would not fast-forward .* — clear what git names, .*index\.lock/,
	);
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
});

it("levels against the last fetched origin/main where the fetch fails, and says so", () => {
	const green = landOnMain({ "hook.js": "v2\n" });
	git(main, "fetch", "-q", "origin");
	git(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));

	const r = run(main);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("main fast-forwarded");
	expect(r.stderr).toContain("fetching origin/main failed");
	expect(git(main, "rev-parse", "HEAD")).toBe(green);
});

it("does nothing while another pass holds the lock, and sweeps what a killed pass left", () => {
	landOnMain({ "hook.js": "v2\n" });
	const before = git(main, "rev-parse", "HEAD");
	sleeper = spawn(
		process.execPath,
		["-e", "setTimeout(() => {}, 60000)", "level-main.js"],
		{ stdio: "ignore" },
	);
	const pidfile = path.join(main, ".git", "wfc-level.pid");
	fs.writeFileSync(pidfile, `${sleeper.pid}\n`);
	const leftover = path.join(main, ".git", "wfc-level", "install");
	fs.mkdirSync(leftover, { recursive: true });

	const busy = pass();

	expect(busy).toMatchObject({ status: "busy", holder: sleeper.pid });
	expect(renderOutcome(busy, Date.now())[0]).toContain(
		`another levelling pass (pid ${sleeper.pid}) holds the lock`,
	);
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
	expect(fs.existsSync(leftover)).toBe(true);

	sleeper.kill();
	sleeper = null;
	fs.writeFileSync(pidfile, "999999999\n");
	expect(pass()).toMatchObject({ status: "forwarded" });
	expect(fs.existsSync(leftover)).toBe(false);
	expect(fs.existsSync(pidfile)).toBe(false);
});

it("refuses a stray argument, and a directory no main checkout holds", () => {
	const outside = fs.mkdtempSync(path.join(tmp, "bare-dir-"));

	expect(run(main, "extra").status).toBe(2);
	const r = run(outside);
	expect(r.status).toBe(1);
	expect(r.stderr).toContain("no main checkout holds this directory");
});

const writerLog = () => path.join(tmp, "writer-runs");

/* CANARY_FILES, its writer also logging each run to writerLog. Landed and
 * levelled with no session live. */
const seedCanary = () => {
	/* The writer's fail-open log, here and in the pass's own runs of it. */
	vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmp, "config"));
	const files: Record<string, string> = {};
	for (const f of CANARY_FILES)
		files[f] = fs.readFileSync(path.join(REPO, f), "utf8");
	const writer = "scripts/write-self-plugin-marker.sh";
	files[writer] = (files[writer] ?? "").replace(
		/exit 0\n$/,
		`echo "$CLAUDE_PROJECT_DIR" >> ${shellQuote(writerLog())}\nexit 0\n`,
	);
	landOnMain(files);
	expect(pass({ listSessions: () => ({ sessions: [] }) }).status).toBe(
		"forwarded",
	);
	return files;
};

const movedMarkerPath = (files: Record<string, string>) => ({
	[MARKER_LIB]: (files[MARKER_LIB] ?? "").replaceAll(
		".self-plugin-loaded-",
		".self-plugin-v2-",
	),
});

const hook = (script: string, sessionId: string) =>
	spawnSync("bash", [path.join(main, "scripts", script)], {
		cwd: worktree,
		input: JSON.stringify({ session_id: sessionId }),
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: path.join(tmp, "config"),
			CLAUDE_PLUGIN_ROOT: path.join(main, "self-plugin"),
			CLAUDE_PROJECT_DIR: worktree,
		},
		encoding: "utf8",
	});

const startSession = (sessionId: string) => {
	expect(hook("write-self-plugin-marker.sh", sessionId).status).toBe(0);
	fs.rmSync(writerLog(), { force: true });
};

const canaryPasses = (sessionId: string) =>
	hook("self-plugin-canary.sh", sessionId).status === 0;

const live =
	(...ids: string[]) =>
	() => ({
		sessions: ids.map((sessionId) => ({ sessionId, cwd: worktree })),
	});

it("re-marks a live session before a fast-forward that moves its marker path, so its next canary call passes (#4711)", () => {
	const files = seedCanary();
	startSession("s-old");
	const moved = landOnMain(movedMarkerPath(files));

	expect(pass({ listSessions: live("s-old") })).toMatchObject({
		status: "forwarded",
		head: moved,
	});
	/* The pass's writer records the main checkout's self-plugin (#4712). */
	expect(
		fs.readFileSync(
			path.join(worktree, ".claude", "tmp", "markers", ".self-plugin-v2-s-old"),
			"utf8",
		),
	).toBe(path.join(main, "self-plugin"));
	expect(fs.readFileSync(writerLog(), "utf8")).toBe(`${worktree}\n`);
	expect(canaryPasses("s-old")).toBe(true);
});

it("does not fast-forward where the target canary still refuses a re-marked session, and names the session", () => {
	seedCanary();
	startSession("s-live");
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({
		"scripts/self-plugin-canary.sh":
			"#!/usr/bin/env bash\necho 'cannot start' >&2\nexit 2\n",
	});

	const o = pass({ listSessions: live("s-live") });

	expect(o).toMatchObject({
		status: "stranding",
		stranded: [
			{ sessionId: "s-live", projectDir: worktree, refusal: "cannot start" },
		],
	});
	const lines = renderOutcome(o, Date.now());
	expect(lines[0]).toMatch(
		/^refused: \S+ changes the self-plugin canary, which would still refuse 1 live session\(s\)/,
	);
	expect(lines[1]).toBe(`  session s-live in ${worktree} — cannot start`);
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
	expect(canaryPasses("s-live")).toBe(true);
});

it("does not fast-forward a canary change where the live sessions cannot be listed", () => {
	seedCanary();
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({ "scripts/lib/script-path.sh": "# changed\n" });

	const o = pass({ listSessions: () => ({ why: "the oracle is down" }) });

	expect(o).toMatchObject({ status: "stranding", why: "the oracle is down" });
	expect(renderOutcome(o, Date.now())[0]).toMatch(
		/^refused: .* the re-mark it owes the live sessions could not run, so main was not moved .*: the oracle is down$/,
	);
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
});

it("gives no marker to a session the current canary already refuses", () => {
	const files = seedCanary();
	landOnMain(movedMarkerPath(files));

	expect(pass({ listSessions: live("s-unloaded") }).status).toBe("forwarded");
	expect(fs.existsSync(writerLog())).toBe(false);
	expect(canaryPasses("s-unloaded")).toBe(false);
});

it("runs no re-mark where the fast-forward changes none of the canary's files", () => {
	seedCanary();
	startSession("s-live");
	landOnMain({ "hook.js": "v2\n" });
	let listed = 0;
	const listSessions = () => {
		listed += 1;
		return { sessions: [] };
	};

	expect(pass({ listSessions }).status).toBe("forwarded");
	expect(listed).toBe(0);
	expect(fs.existsSync(writerLog())).toBe(false);
});

it("does not fast-forward a canary that sources a file in a form the re-mark cannot follow", () => {
	const files = seedCanary();
	const canary = "scripts/self-plugin-canary.sh";
	const before = git(main, "rev-parse", "HEAD");
	landOnMain({
		[canary]: (files[canary] ?? "").replace(
			"set -uo pipefail\n",
			'set -uo pipefail\n. "$here"/lib/extra.sh\n',
		),
	});

	expect(pass({ listSessions: live() })).toMatchObject({
		status: "stranding",
		why: `${canary} sources "$here"/lib/extra.sh, which the re-mark cannot follow`,
	});
	expect(git(main, "rev-parse", "HEAD")).toBe(before);
});
