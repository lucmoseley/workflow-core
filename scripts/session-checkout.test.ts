// @vitest-environment node
/*
 * scripts/session-checkout.js against real git (#4235): a bare origin carrying
 * `main` and `landing`, a main checkout cloned from it, and the linked
 * worktrees each cut adds. `npm` is a stub that records each install.
 *
 * Loosen it and a session starts on stale work or local `main`, two sessions
 * install into one tree, a tool writes under a store every neighbour on its
 * lockfile reads, or a lockfile change runs against a tree built for another
 * lockfile.
 *
 * Every case cuts real worktrees off a real bare origin, seam 1's fixture
 * (#4229), so the file runs over the 10 s budget (base §X8 (5)).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import vitestConfig from "../vitest.config";
import {
	buildBashPayload,
	dispatchCoreOutput,
} from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const SCRIPT = path.resolve(__dirname, "session-checkout.js");

let tmp: string;
let origin: string;
let main: string;
let npmCalls: string;
let npmStub: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitIn = (
	cwd: string,
	files: Record<string, string>,
	message: string,
) => {
	for (const [name, text] of Object.entries(files))
		fs.writeFileSync(path.join(cwd, name), text);
	git(cwd, "add", "-A");
	git(cwd, "commit", "-qm", message);
	return git(cwd, "rev-parse", "HEAD");
};

const run = (cwd: string, ...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd,
		env: { ...process.env, CLAUDE_PROJECT_DIR: main, WFC_NPM: npmStub },
	});

const readInstalls = () =>
	fs.existsSync(npmCalls)
		? fs.readFileSync(npmCalls, "utf8").split("\n").filter(Boolean)
		: [];

const worktree = (name: string) =>
	path.join(main, ".claude", "worktrees", name);
const stores = () => path.join(main, ".claude", "worktrees", ".dep-stores");
const storeOf = (name: string) =>
	fs.realpathSync(path.join(worktree(name), "node_modules"));

/** Remove `dir`, a frozen store's write bits given back first. */
const removeTree = (dir: string) => {
	if (fs.existsSync(dir)) execFileSync("chmod", ["-R", "u+w", dir]);
	fs.rmSync(dir, { recursive: true, force: true });
};

const landOnOrigin = (files: Record<string, string>) => {
	const other = path.join(tmp, "other");
	git(tmp, "clone", "-q", "-b", "landing", origin, other);
	git(other, "config", "user.email", "t@t");
	git(other, "config", "user.name", "t");
	const sha = commitIn(other, files, "landed elsewhere");
	git(other, "push", "-q", "origin", "HEAD:landing");
	return sha;
};

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkout-")));
	origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
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
			".gitignore": "/node_modules\n.claude/worktrees/\n",
			"package.json": "{}\n",
			"package-lock.json": "lock-1\n",
		},
		"seed",
	);
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	commitIn(main, { "landed.txt": "x" }, "landed");
	git(main, "push", "-q", "origin", "HEAD:landing");
	git(main, "reset", "-q", "--hard", "origin/main");
});

afterEach(() => removeTree(tmp));

it("cuts a worktree detached at a freshly fetched origin/landing under the worktrees folder", () => {
	const ahead = landOnOrigin({ "elsewhere.txt": "y" });

	const r = run(main, "cut", "brisk-otter");

	expect(r.status, r.stderr).toBe(0);
	const dir = worktree("brisk-otter");
	expect(r.stdout).toBe(`${dir}\n`);
	expect(git(dir, "rev-parse", "HEAD")).toBe(ahead);
	expect(git(dir, "rev-parse", "origin/landing")).toBe(ahead);
	expect(() => git(dir, "symbolic-ref", "-q", "HEAD")).toThrow();
	expect(git(main, "worktree", "list", "--porcelain")).toContain(
		`worktree ${dir}\n`,
	);
});

it("cuts from inside a linked worktree into the main checkout's worktrees folder", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	fs.mkdirSync(path.join(worktree("one"), "sub"));

	const r = run(path.join(worktree("one"), "sub"), "cut", "two");

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe(`${worktree("two")}\n`);
	expect(storeOf("two")).toBe(storeOf("one"));
});

it("shares one store between cuts with the same lockfile, and builds a second for a differing one", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	expect(run(main, "cut", "two").status).toBe(0);

	expect(storeOf("one")).toBe(storeOf("two"));
	expect(readInstalls()).toHaveLength(1);

	landOnOrigin({ "package-lock.json": "lock-2\n" });
	expect(run(main, "cut", "three").status).toBe(0);

	expect(storeOf("three")).not.toBe(storeOf("one"));
	expect(fs.readFileSync(path.join(storeOf("three"), "lock"), "utf8")).toBe(
		"lock-2\n",
	);
	expect(readInstalls()).toHaveLength(2);
});

it("re-attaches a worktree whose work changed the lockfile to a store built for it, from any directory in it, leaving the old store as it was", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	const before = storeOf("one");
	fs.writeFileSync(path.join(dir, "package-lock.json"), "lock-3\n");
	fs.mkdirSync(path.join(dir, "sub"));

	const r = run(path.join(dir, "sub"), "attach");

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain(`${dir} uses `);
	const after = storeOf("one");
	expect(after).not.toBe(before);
	expect(fs.readFileSync(path.join(after, "lock"), "utf8")).toBe("lock-3\n");
	expect(fs.readFileSync(path.join(before, "lock"), "utf8")).toBe("lock-1\n");
	expect(git(dir, "status", "--porcelain")).toBe("M package-lock.json");
});

it("leaves a built store read-only, so nothing run in a worktree writes under it", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const link = path.join(worktree("one"), "node_modules");

	/* Vite's config bundle and vitest's cache are the writes ordinary use makes
	 * under node_modules; vite falls back beside its source on EACCES. */
	expect(() => fs.mkdirSync(path.join(link, ".vite-temp"))).toThrow(/EACCES/);
	expect(() => fs.writeFileSync(path.join(link, "lock"), "x")).toThrow(
		/EACCES/,
	);
	expect(fs.readFileSync(path.join(link, "lock"), "utf8")).toBe("lock-1\n");
	/* Vite's own default, `node_modules/.vite`, would sit in the store. */
	expect(vitestConfig.cacheDir).toBeTypeOf("string");
	expect(String(vitestConfig.cacheDir).split("/")).not.toContain(
		"node_modules",
	);
});

it("refuses an install aimed at a cut worktree with the re-attach route, and lets the lockfile-only change through", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const config = path.join(tmp, "config");
	fs.mkdirSync(config);
	const guard = (command: string) =>
		dispatchCoreOutput(
			"guard-npm-install",
			{ ...buildBashPayload(command, "test"), cwd: worktree("one") },
			{ project: main, config, cwd: main, env: { WFC_NPM: npmStub } },
		);

	const refused = guard("npm install");

	expect(refused?.permissionDecision).toBe("deny");
	expect(refused?.permissionDecisionReason).toContain(
		`would write through ${worktree("one")}/node_modules, a link to ${storeOf("one")}`,
	);
	expect(refused?.permissionDecisionReason).toMatch(
		/--package-lock-only`.*then `node \S*session-checkout\.js attach`/,
	);
	expect(guard("npm install --package-lock-only")).toBeNull();
});

it("attaches a worktree named on the command line", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	fs.writeFileSync(path.join(worktree("one"), "package-lock.json"), "lock-4\n");

	const r = run(main, "attach", worktree("one"));

	expect(r.status, r.stderr).toBe(0);
	expect(fs.readFileSync(path.join(storeOf("one"), "lock"), "utf8")).toBe(
		"lock-4\n",
	);
});

it("waits on a live builder of the same store and reuses what it built, running no second install", async () => {
	expect(run(main, "cut", "one").status).toBe(0);
	fs.writeFileSync(path.join(worktree("one"), "package-lock.json"), "lock-5\n");
	const key = String(fs.readdirSync(stores()).find((n) => !n.startsWith(".")));
	removeTree(path.join(stores(), key));
	const lock = path.join(stores(), `.build-${key}.lock`);
	const built = path.join(stores(), key, "node_modules");
	/* A real neighbour process and the real clock: the lock is read by pid
	 * liveness, and the waiter polls in wall time. */
	const holder = spawn(
		"sh",
		[
			"-c",
			`echo $$ > ${shellQuote(lock)}; sleep 1; mkdir -p ${shellQuote(built)}; rm ${shellQuote(lock)}`,
		],
		{ stdio: "ignore" },
	);
	while (!fs.existsSync(lock))
		await new Promise((done) => setTimeout(done, 20));
	fs.writeFileSync(npmCalls, "");
	fs.writeFileSync(path.join(worktree("one"), "package-lock.json"), "lock-1\n");

	const r = run(worktree("one"), "attach");
	await new Promise((done) => holder.on("exit", done));

	expect(r.status, r.stderr).toBe(0);
	expect(storeOf("one")).toBe(fs.realpathSync(built));
	expect(readInstalls()).toEqual([]);
});

it("takes over a build lock whose holder is dead", () => {
	expect(run(main, "cut", "probe").status).toBe(0);
	const key = String(fs.readdirSync(stores()).find((n) => !n.startsWith(".")));
	removeTree(path.join(stores(), key));
	const lock = path.join(stores(), `.build-${key}.lock`);
	const dead = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
	fs.writeFileSync(lock, dead.stdout);
	fs.writeFileSync(npmCalls, "");

	const r = run(main, "cut", "one");

	expect(r.status, r.stderr).toBe(0);
	expect(readInstalls()).toHaveLength(1);
	expect(fs.existsSync(lock)).toBe(false);
});

it("refuses a name a worktree already holds, and a name that is no session name, each with its way out", () => {
	expect(run(main, "cut", "one").status).toBe(0);

	const again = run(main, "cut", "one");
	const dotted = run(main, "cut", ".dep-stores");

	expect(again.status).toBe(1);
	expect(again.stderr).toContain("already exists — pick another session name");
	expect(dotted.status).toBe(1);
	expect(dotted.stderr).toContain("is no session name: letters, digits");
});

it("refuses to attach the main checkout, and a worktree whose node_modules is a real directory", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const link = path.join(worktree("one"), "node_modules");
	fs.rmSync(link);
	fs.mkdirSync(link);

	const onMain = run(main, "attach");
	const onDir = run(worktree("one"), "attach");

	expect(onMain.status).toBe(1);
	expect(onMain.stderr).toContain("run attach from a session worktree");
	expect(onDir.status).toBe(1);
	expect(onDir.stderr).toContain("move it aside, then attach again");
});

it("attaches nothing to a worktree with no lockfile", () => {
	landOnOrigin({ "package-lock.json": "" });
	git(path.join(tmp, "other"), "rm", "-q", "package-lock.json");
	git(path.join(tmp, "other"), "commit", "-qm", "drop lock");
	git(path.join(tmp, "other"), "push", "-q", "origin", "HEAD:landing");

	const r = run(main, "cut", "one");

	expect(r.status, r.stderr).toBe(0);
	expect(fs.existsSync(path.join(worktree("one"), "node_modules"))).toBe(false);
	expect(readInstalls()).toEqual([]);
});

it("exits 2 on a usage error", () => {
	expect(run(main, "cut").status).toBe(2);
	expect(run(main, "attach", "a", "b").status).toBe(2);
});

it("leaves no worktree and no store behind where the install fails, and says how to retry", () => {
	fs.writeFileSync(npmStub, "#!/bin/sh\nexit 7\n");

	const r = run(main, "cut", "one");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("npm ci exited 7");
	expect(r.stderr).toContain("then attach again");
	expect(fs.existsSync(worktree("one"))).toBe(false);
	expect(fs.readdirSync(stores())).toEqual([]);
	expect(git(main, "worktree", "list")).not.toContain("one");
});
