// @vitest-environment node
/*
 * scripts/session-checkout.js against real git (#4235): a bare origin carrying
 * `main` and `landing`, a main checkout cloned from it, and the linked
 * worktrees each cut adds. `npm` is a stub that records each install.
 *
 * Loosen it and a session starts on stale work or local `main`, two sessions
 * install into one tree, a tool writes under a store every neighbour on its
 * lockfile reads, or a lockfile change runs against a tree built for another
 * lockfile. Loosen `land` (#4239) and a merge commit skips the pre-commit
 * gates, a push raced by a neighbour is lost or misreported, a registry-anchor
 * conflict costs a hand merge, or uncommitted work reads as landed.
 *
 * Every land runs with the `landing` module on and a live process holding the
 * lander's lock, so start-lander.js answers without starting a real lander.
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
import { isUnder } from "./lib/is-under.js";
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

const DRIVER = path.resolve(__dirname, "merge-registry-anchors.js");

/* A sandboxed config dir: a land a neighbour beats files a divergence row
 * there, never in the founder's live log. */
const ENV = () => ({
	...process.env,
	CLAUDE_CONFIG_DIR: path.join(tmp, "config"),
	CLAUDE_PROJECT_DIR: main,
	WFC_NPM: npmStub,
	WFC_MODULES: "landing",
});

const run = (cwd: string, ...args: string[]) =>
	runInProcess(SCRIPT, args, { cwd, env: ENV() });

const readInstalls = () =>
	fs.existsSync(npmCalls)
		? fs.readFileSync(npmCalls, "utf8").split("\n").filter(Boolean)
		: [];

const worktree = (name: string) =>
	path.join(main, ".claude", "worktrees", name);
/** The session worktrees standing, the dot-named store folder left out. */
const listWorktrees = () =>
	fs
		.readdirSync(path.join(main, ".claude", "worktrees"))
		.filter((d) => !d.startsWith("."));
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
	if (fs.existsSync(other)) {
		git(other, "fetch", "-q", "origin");
		git(other, "reset", "-q", "--hard", "origin/landing");
	} else {
		git(tmp, "clone", "-q", "-b", "landing", origin, other);
		git(other, "config", "user.email", "t@t");
		git(other, "config", "user.name", "t");
	}
	const sha = commitIn(other, files, "landed elsewhere");
	git(other, "push", "-q", "origin", "HEAD:landing");
	return sha;
};

let landerHolder: ReturnType<typeof spawn> | undefined;

const markers = () => path.join(main, ".claude", "tmp", "markers");

/** A live process whose command line names lander.js, in the lander's lock. */
const holdLanderLock = () => {
	landerHolder = spawn("sh", ["-c", "sleep 60", "lander.js"], {
		stdio: "ignore",
	});
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(
		path.join(markers(), ".lander.pid"),
		`${landerHolder.pid}\n`,
	);
	return landerHolder.pid;
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
	holdLanderLock();
});

afterEach(() => {
	landerHolder?.kill();
	landerHolder = undefined;
	removeTree(tmp);
});

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

it("gives a launch a worktree named for its prompt where the repository lands through landing (#4245)", () => {
	const ahead = landOnOrigin({ "elsewhere.txt": "y" });

	const first = run(main, "launch-dir", "/implement 4245");
	const second = run(main, "launch-dir", "/implement 4245");

	const dirs = [first, second].map((r) => {
		expect(r.status, r.stderr).toBe(0);
		const dir = r.stdout.trim();
		expect(path.dirname(dir)).toBe(path.join(main, ".claude", "worktrees"));
		expect(path.basename(dir)).toMatch(/^implement-4245-[0-9a-f]{6}$/);
		expect(git(dir, "rev-parse", "HEAD")).toBe(ahead);
		return dir;
	});
	expect(dirs[1]).not.toBe(dirs[0]);
});

it("gives a launch --into an existing session worktree that worktree, uncut and its work kept (#4385)", () => {
	const dead = run(main, "cut", "dead-one").stdout.trim();
	fs.writeFileSync(path.join(dead, "half-done.txt"), "uncommitted");

	const r = run(main, "launch-dir", "--into", dead, "/implement 4385");

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe(`${dead}\n`);
	expect(fs.readFileSync(path.join(dead, "half-done.txt"), "utf8")).toBe(
		"uncommitted",
	);
	expect(listWorktrees()).toEqual(["dead-one"]);
});

it("refuses a launch --into a worktree a live process still works in, naming its pid (#4385)", () => {
	const dead = run(main, "cut", "still-held").stdout.trim();
	/* 60 s outlives the case; `finally` kills it. */
	const holder = spawn("sh", ["-c", "sleep 60"], {
		cwd: dead,
		stdio: "ignore",
	});
	try {
		const r = run(main, "launch-dir", "--into", dead, "/implement 4385");

		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain(
			`session checkout: a live process still works in ${dead} (pid ${holder.pid}`,
		);
	} finally {
		holder.kill();
	}
});

it("refuses a launch --into a directory that is no session worktree, naming the directory (#4385)", () => {
	for (const into of [main, path.join(tmp, "elsewhere")]) {
		const r = run(main, "launch-dir", "--into", into, "/implement 4385");

		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${into} is no session worktree of ${main}`);
	}
});

it("gives a launch the main checkout itself where the repository has no landing module", () => {
	const r = runInProcess(SCRIPT, ["launch-dir", "/implement 4245"], {
		cwd: main,
		env: { ...ENV(), WFC_MODULES: "" },
	});

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe(`${main}\n`);
	expect(fs.existsSync(path.join(main, ".claude", "worktrees"))).toBe(false);
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

it("warms the store for origin/landing's lockfile, so a no-build launch then cuts with no install of its own (#4318)", () => {
	landOnOrigin({ "package-lock.json": "lock-3\n" });

	const warmed = run(main, "warm");
	const again = run(main, "warm");
	const launched = run(main, "launch-dir", "--no-build", "/implement 4318");

	expect(warmed.status, warmed.stderr).toBe(0);
	expect(again.status, again.stderr).toBe(0);
	expect(launched.status, launched.stderr).toBe(0);
	const dir = launched.stdout.trim();
	const store = path.dirname(fs.realpathSync(path.join(dir, "node_modules")));
	expect(warmed.stderr).toBe(
		`session checkout: origin/landing's lockfile uses ${store}, built now\n`,
	);
	expect(
		fs.readFileSync(path.join(store, "node_modules", "lock"), "utf8"),
	).toBe("lock-3\n");
	expect(readInstalls()).toHaveLength(1);
});

it("refuses a no-build launch that meets no store at once, naming the warm route, with no install and no worktree left (#4318)", () => {
	const r = run(main, "launch-dir", "--no-build", "/implement 4318");

	expect(r.status).toBe(1);
	expect(r.stdout).toBe("");
	expect(r.stderr).toMatch(
		/^session checkout: no dependency store stands for this lockfile yet \([0-9a-f]{16}\), and this cut builds none; the refill tick's warm pass \(`node scripts\/session-checkout\.js warm`\) builds it, and the next tick launches this member\n$/,
	);
	expect(readInstalls()).toEqual([]);
	expect(listWorktrees()).toEqual([]);
});

it("names a failed warm build in each no-build refusal until a build succeeds, which clears it (#4318)", () => {
	fs.writeFileSync(
		npmStub,
		"#!/bin/sh\necho registry unreachable >&2\nexit 7\n",
	);

	const failed = run(main, "warm");
	const refused = run(main, "launch-dir", "--no-build", "/implement 4318");

	expect(failed.status).toBe(1);
	expect(refused.status).toBe(1);
	expect(refused.stderr).toMatch(
		/^session checkout: no dependency store stands for this lockfile yet \([0-9a-f]{16}\), and this cut builds none; its last build failed — npm ci exited 7 building a store in .* — so no tick launches this member until a warm pass \(`node scripts\/session-checkout\.js warm`\) builds it\n$/,
	);

	fs.writeFileSync(
		npmStub,
		`#!/bin/sh\nmkdir node_modules && cp package-lock.json node_modules/lock && pwd >> ${shellQuote(npmCalls)}\n`,
	);
	expect(run(main, "warm").status).toBe(0);
	expect(run(main, "launch-dir", "--no-build", "/implement 4318").status).toBe(
		0,
	);
	expect(fs.readdirSync(stores()).filter((n) => n.endsWith(".failed"))).toEqual(
		[],
	);
});

it("leaves a live builder of origin/landing's store to finish when warming, running no install of its own", () => {
	expect(run(main, "warm").status).toBe(0);
	const key = String(fs.readdirSync(stores()).find((n) => !n.startsWith(".")));
	removeTree(path.join(stores(), key));
	fs.writeFileSync(npmCalls, "");
	const holder = spawn("sleep", ["60"], { stdio: "ignore" });
	fs.writeFileSync(
		path.join(stores(), `.build-${key}.lock`),
		`${holder.pid}\n`,
	);

	const r = run(main, "warm");
	holder.kill();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe(
		`session checkout: origin/landing's lockfile uses ${path.join(stores(), key)}, which another process is building\n`,
	);
	expect(readInstalls()).toEqual([]);
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
	const treeRoot = path.resolve(__dirname, "..");
	const cache = path.resolve(treeRoot, String(vitestConfig.cacheDir));
	expect(isUnder(cache, [treeRoot], path.sep)).toBe(true);
	expect(path.relative(treeRoot, cache).split(path.sep)).not.toContain(
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

it("leaves no worktree and no store behind where the install fails, only the failure's record, and says how to retry", () => {
	fs.writeFileSync(npmStub, "#!/bin/sh\nexit 7\n");

	const r = run(main, "cut", "one");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("npm ci exited 7");
	expect(r.stderr).toContain("then attach again");
	expect(fs.existsSync(worktree("one"))).toBe(false);
	const left = fs.readdirSync(stores());
	expect(left).toEqual([
		expect.stringMatching(/^\.build-[0-9a-f]{16}\.failed$/),
	]);
	expect(
		fs.readFileSync(path.join(stores(), String(left[0])), "utf8"),
	).toContain("npm ci exited 7");
	expect(git(main, "worktree", "list")).not.toContain("one");
});

/** Hooks for every tree of the main checkout, `pre-merge-commit` among them. */
const installHooks = (hooks: Record<string, string>) => {
	const dir = path.join(tmp, "hooks");
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(hooks)) {
		fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
		fs.chmodSync(path.join(dir, name), 0o755);
	}
	git(main, "config", "core.hooksPath", dir);
};

const parents = (cwd: string, rev: string) =>
	git(cwd, "rev-list", "--parents", "-n1", rev).split(" ").slice(1);

const landingTip = () => git(origin, "rev-parse", "landing");

it("lands a worktree: merges the moved origin/landing, the merge commit running pre-merge-commit, and pushes HEAD:landing", () => {
	const ran = path.join(tmp, "merge-hook-ran");
	installHooks({ "pre-merge-commit": `echo ran >> ${shellQuote(ran)}` });
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	const mine = commitIn(dir, { "mine.txt": "m" }, "mine");
	const theirs = landOnOrigin({ "theirs.txt": "t" });

	const r = run(dir, "land");

	expect(r.status, r.stderr).toBe(0);
	const head = git(dir, "rev-parse", "HEAD");
	expect(landingTip()).toBe(head);
	expect(parents(dir, head)).toEqual([mine, theirs]);
	expect(fs.readFileSync(ran, "utf8")).toBe("ran\n");
	expect(r.stderr).toContain(
		`pushed ${head} to landing, origin/landing merged in first`,
	);
	const started = `SKIP: a lander is already running (pid ${landerHolder?.pid})`;
	expect(r.stderr).toContain(started);
	expect(fs.readFileSync(path.join(markers(), ".lander.log"), "utf8")).toBe(
		`${started}\n`,
	);
});

it("pushes a worktree already ahead of origin/landing with no merge, and lands nothing where HEAD is on it", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");

	const idle = run(dir, "land");
	const mine = commitIn(dir, { "mine.txt": "m" }, "mine");
	const ahead = run(dir, "land");

	expect(idle.status, idle.stderr).toBe(0);
	expect(idle.stderr).toContain("nothing to land");
	expect(ahead.status, ahead.stderr).toBe(0);
	expect(landingTip()).toBe(mine);
	expect(git(dir, "rev-parse", "HEAD")).toBe(mine);
});

it("reports a push raced by a neighbour with the land-again route, and landing again merges the newer tip and pushes", () => {
	const raced = path.join(tmp, "raced");
	const other = path.join(tmp, "other");
	landOnOrigin({ "first.txt": "1" });
	/* The neighbour pushes between land's fetch and its push, from inside the
	 * merge's hook, once. */
	installHooks({
		"pre-merge-commit": [
			"unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE",
			`[ -e ${shellQuote(raced)} ] && exit 0`,
			`touch ${shellQuote(raced)}`,
			`echo 2 > ${shellQuote(path.join(other, "second.txt"))}`,
			`git -C ${shellQuote(other)} add -A && git -C ${shellQuote(other)} commit -qm second && git -C ${shellQuote(other)} push -q origin HEAD:landing`,
		].join("\n"),
	});
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "mine.txt": "m" }, "mine");
	landOnOrigin({ "third.txt": "3" });

	const first = run(dir, "land");

	expect(first.status).toBe(1);
	expect(first.stderr).toContain(
		"landing moved after the fetch: a neighbour pushed first — land again",
	);
	const neighbour = landingTip();
	expect(git(other, "rev-parse", "HEAD")).toBe(neighbour);
	/* One `land` row, counted against the re-fetched origin/landing: HEAD
	 * carries mine and its merge, the neighbour's commit is the one behind. */
	const projects = path.join(tmp, "config", "projects");
	const rows = fs
		.readdirSync(projects)
		.flatMap((d) => {
			const log = path.join(projects, d, "divergence.log");
			return fs.existsSync(log)
				? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
				: [];
		})
		.map((line) => line.split("\t"));
	expect(rows.map((r) => [...r.slice(1, 6), r[7]])).toEqual([
		["main", "land", "2", "1", "diverged", "origin/landing"],
	]);

	const second = run(dir, "land");

	expect(second.status, second.stderr).toBe(0);
	const head = git(dir, "rev-parse", "HEAD");
	expect(landingTip()).toBe(head);
	expect(parents(dir, head)[1]).toBe(neighbour);
});

it("settles a registry-anchor conflict through the per-row merge driver, with no hand merge", () => {
	const anchors = ".claude/guard-registry-anchors.json";
	const write = (rows: Record<string, string>) =>
		`${JSON.stringify(rows, null, "\t")}\n`;
	landOnOrigin({
		".gitattributes": `${anchors} merge=registry-anchors\n`,
	});
	fs.mkdirSync(path.join(tmp, "other", ".claude"), { recursive: true });
	landOnOrigin({ [anchors]: write({ a: "a0", b: "b0" }) });
	git(
		main,
		"config",
		"merge.registry-anchors.driver",
		`node ${shellQuote(DRIVER)} %O %A %B`,
	);
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { [anchors]: write({ a: "a1", b: "b0" }) }, "mine");
	landOnOrigin({ [anchors]: write({ a: "a0", b: "b2" }) });

	const r = run(dir, "land");

	expect(r.status, r.stderr).toBe(0);
	expect(git(origin, "show", `landing:${anchors}`)).toBe(
		write({ a: "a1", b: "b2" }).trim(),
	);
});

it("leaves any other conflict for the session to resolve and commit, naming the files, then lands", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "shared.txt": "mine\n" }, "mine");
	landOnOrigin({ "shared.txt": "theirs\n" });

	const r = run(dir, "land");
	const again = run(dir, "land");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"merging origin/landing conflicts in shared.txt — resolve them and `git commit`",
	);
	expect(again.status).toBe(1);
	expect(again.stderr).toContain("a merge is in progress in this worktree");

	fs.writeFileSync(path.join(dir, "shared.txt"), "both\n");
	git(dir, "add", "shared.txt");
	git(dir, "commit", "-q", "--no-edit");
	const landed = run(dir, "land");

	expect(landed.status, landed.stderr).toBe(0);
	expect(git(origin, "show", "landing:shared.txt")).toBe("both");
});

it("refuses to land from the main checkout, naming the cut route, and refuses a land given an argument", () => {
	const r = run(main, "land");
	const extra = run(main, "land", "extra");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"the main checkout is never landed from — land from your session worktree, or cut one with `node scripts/session-checkout.js cut <session-name>`",
	);
	expect(extra.status).toBe(2);
	expect(extra.stderr).toContain(
		"usage: node scripts/session-checkout.js land",
	);
});

it("refuses to land a worktree with uncommitted changes, naming them, and pushes nothing", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "mine.txt": "m" }, "mine");
	fs.writeFileSync(path.join(dir, "mine.txt"), "edited");
	const before = landingTip();

	const r = run(dir, "land");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"uncommitted changes to mine.txt would not land — commit them",
	);
	expect(landingTip()).toBe(before);
});

it("refuses to land with the landing module off, naming the route that module's absence leaves", () => {
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "mine.txt": "m" }, "mine");

	const r = runInProcess(SCRIPT, ["land"], {
		cwd: dir,
		env: { ...ENV(), WFC_MODULES: "" },
	});

	expect(r.status).toBe(1);
	expect(r.stderr).toContain('module "landing" is off');
	expect(r.stderr).toContain("push to main as `rule:branch-publish` says");
});

it("leaves a merge a gate refused in progress, saying to fix the finding and commit, and pushes nothing", () => {
	installHooks({ "pre-merge-commit": "echo gate says no >&2; exit 1" });
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "mine.txt": "m" }, "mine");
	const theirs = landOnOrigin({ "theirs.txt": "t" });

	const r = run(dir, "land");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("gate says no");
	expect(r.stderr).toContain(
		"the merge of origin/landing was refused, its output above — fix the finding and `git commit`",
	);
	expect(git(dir, "rev-parse", "MERGE_HEAD")).toBe(theirs);
	expect(landingTip()).toBe(theirs);
});

it("reports a push a hook refused as a finding to fix, not a race", () => {
	installHooks({ "pre-push": "echo push gate says no >&2; exit 1" });
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	commitIn(dir, { "mine.txt": "m" }, "mine");
	const before = landingTip();

	const r = run(dir, "land");

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("push gate says no");
	expect(r.stderr).toContain(
		"the push to landing was refused, its output above — fix the finding, then land again",
	);
	expect(landingTip()).toBe(before);
});

it("reports a landed push as landed where the lander will not start, naming the start to run", () => {
	fs.rmSync(path.join(markers(), ".lander.log"), { force: true });
	fs.mkdirSync(path.join(markers(), ".lander.log"));
	expect(run(main, "cut", "one").status).toBe(0);
	const dir = worktree("one");
	const mine = commitIn(dir, { "mine.txt": "m" }, "mine");

	const r = run(dir, "land");

	expect(r.status, r.stderr).toBe(0);
	expect(landingTip()).toBe(mine);
	expect(r.stderr).toContain(`pushed ${mine} to landing`);
	expect(r.stderr).toMatch(
		/the lander did not start \(.*EISDIR.*\) — run `node \S*start-lander\.js`/,
	);
});
