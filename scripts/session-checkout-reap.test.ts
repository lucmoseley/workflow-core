// @vitest-environment node
/*
 * `session-checkout.js reap` against real git (#4247): a bare origin carrying
 * `main` and `landing`, a main checkout cloned from it, and worktrees cut by
 * the module itself, each linked to a dependency store `npm` (a stub) built.
 *
 * Loosen it and cleanup loses work: a worktree with uncommitted or unlanded
 * commits, or one a live or resumable session still needs, is removed, or a
 * store is pulled from under a worktree or a build in flight. Tighten it and
 * the worktrees folder grows without bound and stranded work goes unnamed.
 *
 * Every case but the young one runs with the clock at least an hour on, past
 * the window a fresh cut or store is left alone in; only `Date` is faked, so git
 * and the processes it spawns keep real time. The reopen cases stand a
 * stub on `WFC_CLAUDE_BIN` for `claude attach`, logging its seat and argv.
 *
 * Every case cuts real worktrees off a real bare origin, seam 1's fixture
 * (#4229), so the file runs at about the 10 s budget (base §X8 (5)).
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FILED_DIR, markerName } from "./lib/orphan-filings.js";
import { runInProcess } from "./lib/run-in-process.js";
import { worktreeLabel } from "./lib/session-worktrees.js";

const SCRIPT = path.resolve(__dirname, "session-checkout.js");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let tmp: string;
let origin: string;
let main: string;
let seat: string;
let npmStub: string;
let held: ReturnType<typeof spawn>[] = [];

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commitIn = (cwd: string, name: string, message: string) => {
	fs.writeFileSync(path.join(cwd, name), message);
	git(cwd, "add", "-A");
	git(
		cwd,
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		message,
	);
};

const run = (args: string[], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, {
		cwd: main,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: main,
			CLAUDE_CONFIG_DIR: seat,
			WFC_NPM: npmStub,
			WFC_MODULES: "landing",
			...env,
		},
	});

const worktrees = () => path.join(main, ".claude", "worktrees");
const worktree = (name: string) => path.join(worktrees(), name);
const stores = () => path.join(worktrees(), ".dep-stores");

const cut = (name: string) => {
	const r = run(["cut", name]);
	expect(r.status, r.stderr).toBe(0);
	return worktree(name);
};

const reap = (ahead = HOUR) => {
	vi.setSystemTime(Date.now() + ahead);
	try {
		return run(["reap"]);
	} finally {
		vi.useRealTimers();
		vi.useFakeTimers({ toFake: ["Date"] });
	}
};

const registered = () =>
	git(main, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((l) => l.startsWith("worktree "))
		.map((l) => l.slice("worktree ".length));

/** A job record on the seat whose session's cwd is `cwd`, in `state`,
 * last written at `updatedAt` where given. */
const recordJob = (
	id: string,
	cwd: string,
	state: string,
	updatedAt?: number,
) => {
	const dir = path.join(seat, "jobs", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "state.json"),
		JSON.stringify({
			sessionId: `${id}-session`,
			cwd,
			state,
			...(updatedAt === undefined
				? {}
				: { updatedAt: new Date(updatedAt).toISOString() }),
		}),
	);
};

const reapedRecord = () =>
	path.join(
		git(main, "rev-parse", "--git-common-dir"),
		"wfc-reaped-worktrees.jsonl",
	);

/** A live process whose command line carries `marker`, with `cwd`. */
const holdProcess = (cwd: string, marker = "held") => {
	const child = spawn("sh", ["-c", "sleep 60", marker], {
		cwd,
		stdio: "ignore",
	});
	held.push(child);
	return child.pid as number;
};

/** A pid no process holds: an exited child, already reaped. */
const deadPid = () => spawnSync("true").pid;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reap-")));
	origin = path.join(tmp, "origin.git");
	main = path.join(tmp, "main");
	seat = path.join(tmp, "seat");
	npmStub = path.join(tmp, "npm");
	fs.mkdirSync(seat);
	fs.writeFileSync(
		npmStub,
		"#!/bin/sh\nmkdir node_modules && cp package-lock.json node_modules/lock\n",
	);
	fs.chmodSync(npmStub, 0o755);
	git(tmp, "init", "-q", "--bare", "-b", "main", origin);
	git(tmp, "clone", "-q", origin, main);
	fs.writeFileSync(
		path.join(main, ".gitignore"),
		"/node_modules\n.claude/worktrees/\n",
	);
	fs.writeFileSync(path.join(main, "package.json"), "{}\n");
	commitIn(main, "package-lock.json", "lock-1\n");
	git(main, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
});

afterEach(() => {
	vi.useRealTimers();
	for (const child of held) child.kill();
	held = [];
	if (fs.existsSync(tmp)) execFileSync("chmod", ["-R", "u+w", tmp]);
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("removes landed, clean worktrees of finished sessions, then the store none links any more", () => {
	const landed = cut("landed-work");
	const idle = cut("never-worked");
	const store = path.dirname(
		fs.realpathSync(path.join(landed, "node_modules")),
	);
	/* The landed work moves origin/landing's lockfile off the store's. */
	commitIn(landed, "package-lock.json", "lock-2\n");
	git(landed, "push", "-q", "origin", "HEAD:landing");
	recordJob("j1", landed, "done", Date.now() - 4 * DAY);

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain(
		"removed landed worktrees: landed-work, never-worked",
	);
	expect(r.stderr).toContain(
		`removed unlinked dependency store: ${path.basename(store)}`,
	);
	expect(registered()).toEqual([main]);
	expect(fs.existsSync(landed)).toBe(false);
	expect(fs.existsSync(idle)).toBe(false);
	expect(fs.existsSync(store)).toBe(false);
	expect(fs.existsSync(stores())).toBe(true);
});

it("keeps the store for origin/landing's lockfile though no worktree links it, for the next cut (#4318)", () => {
	const gone = cut("gone-session");
	const store = path.dirname(fs.realpathSync(path.join(gone, "node_modules")));

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("removed landed worktree: gone-session");
	expect(r.stderr).not.toContain("removed unlinked dependency store");
	expect(fs.existsSync(path.join(store, "node_modules", "lock"))).toBe(true);
});

it("removes the build failure record of a store no cut can ask for, keeping origin/landing's (#4318)", () => {
	const gone = cut("gone-session");
	const key = path.basename(
		path.dirname(fs.realpathSync(path.join(gone, "node_modules"))),
	);
	fs.writeFileSync(path.join(stores(), `.build-${key}.failed`), "kept\n");
	fs.writeFileSync(
		path.join(stores(), ".build-0123456789abcdef.failed"),
		"stale\n",
	);

	expect(reap().status).toBe(0);

	expect(fs.readdirSync(stores()).filter((n) => n.endsWith(".failed"))).toEqual(
		[`.build-${key}.failed`],
	);
});

it("reports a dead session's dirty or unlanded worktree with its idle time and last commit, removing neither", () => {
	const dirty = cut("dirty-work");
	const unlanded = cut("unlanded-work");
	fs.writeFileSync(path.join(dirty, "half.txt"), "half done");
	commitIn(unlanded, "mine.txt", "never pushed");

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toMatch(
		/stranded: dirty-work — 1 uncommitted path; idle \d+m; last commit [0-9a-f]+ lock-1 — its session is gone: land it with `node scripts\/session-checkout\.js land` from inside it/,
	);
	expect(r.stderr).toMatch(
		/stranded: unlanded-work — 1 commit not on origin\/landing; idle \d+m; last commit [0-9a-f]+ never pushed — /,
	);
	expect(registered()).toEqual(expect.arrayContaining([dirty, unlanded]));
	expect(fs.readFileSync(path.join(dirty, "half.txt"), "utf8")).toBe(
		"half done",
	);
	/* Both still link the store, so it stays. */
	expect(fs.readdirSync(stores())).toHaveLength(1);
});

it("leaves a live session's worktree and a resumable one untouched and unreported, landed or not", () => {
	const live = cut("live-session");
	const parked = cut("parked-session");
	const asking = cut("asking-session");
	fs.writeFileSync(path.join(live, "half.txt"), "in progress");
	holdProcess(live);
	recordJob("j1", parked, "stopped");
	recordJob("j2", asking, "blocked");

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
	expect(registered()).toEqual(expect.arrayContaining([live, parked, asking]));
});

it("prunes a stale registration and removes unregistered directories, reporting one that still has a .git file", () => {
	const gone = cut("gone-dir");
	execFileSync("chmod", ["-R", "u+w", gone]);
	fs.rmSync(gone, { recursive: true });
	const stray = worktree("probe-leftover");
	fs.mkdirSync(path.join(stray, ".claude", "tmp"), { recursive: true });
	fs.writeFileSync(path.join(stray, ".claude", "tmp", "marker"), "x");
	const orphan = worktree("orphaned-checkout");
	fs.mkdirSync(orphan);
	fs.writeFileSync(path.join(orphan, ".git"), "gitdir: /nowhere\n");
	fs.writeFileSync(path.join(orphan, "unsaved.txt"), "work");
	const isolated = worktree("isolated-4242");
	fs.mkdirSync(isolated);
	fs.writeFileSync(path.join(worktrees(), "scratch.log"), "a loose file");

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("pruned stale registration: gone-dir\n");
	expect(r.stderr).toContain("removed unregistered directory: probe-leftover");
	expect(r.stderr).toContain(
		"unregistered checkout: orphaned-checkout has a .git file but no registration, so git cannot read its uncommitted work",
	);
	expect(registered()).toEqual([main]);
	expect(fs.existsSync(stray)).toBe(false);
	expect(fs.readFileSync(path.join(orphan, "unsaved.txt"), "utf8")).toBe(
		"work",
	);
	expect(fs.existsSync(isolated)).toBe(true);
	expect(fs.existsSync(path.join(worktrees(), "scratch.log"))).toBe(true);
});

it("removes a frozen store no worktree links and a dead build's lock and staging, keeping a linked store and a live build's", () => {
	const kept = cut("keeps-store");
	fs.writeFileSync(path.join(kept, "half.txt"), "keeps it standing");
	const linked = path.dirname(fs.realpathSync(path.join(kept, "node_modules")));
	const frozen = path.join(stores(), "0123456789abcdef");
	fs.mkdirSync(path.join(frozen, "node_modules", "pkg"), { recursive: true });
	fs.writeFileSync(path.join(frozen, "node_modules", "pkg", "index.js"), "");
	execFileSync("chmod", ["-R", "a-w", path.join(frozen, "node_modules")]);
	const building = "fedcba9876543210";
	const builder = holdProcess(tmp);
	fs.writeFileSync(
		path.join(stores(), `.build-${building}.lock`),
		`${builder}\n`,
	);
	fs.mkdirSync(path.join(stores(), `.build-${building}-${builder}`));
	fs.mkdirSync(path.join(stores(), building, "node_modules"), {
		recursive: true,
	});
	const dead = deadPid();
	fs.writeFileSync(
		path.join(stores(), ".build-aaaaaaaaaaaaaaaa.lock"),
		`${dead}\n`,
	);
	fs.mkdirSync(path.join(stores(), `.build-aaaaaaaaaaaaaaaa-${dead}`));

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain(
		"removed unlinked dependency store: 0123456789abcdef",
	);
	expect(fs.readdirSync(stores()).sort()).toEqual(
		[
			path.basename(linked),
			building,
			`.build-${building}-${builder}`,
			`.build-${building}.lock`,
		].sort(),
	);
});

it("leaves a worktree, directory or store changed within the last five minutes alone", () => {
	const fresh = cut("just-cut");
	const stray = worktree("half-made");
	fs.mkdirSync(stray);

	const r = reap(0);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
	expect(fs.existsSync(fresh)).toBe(true);
	expect(fs.existsSync(stray)).toBe(true);
	expect(fs.readdirSync(stores())).toHaveLength(1);
});

it("leaves a locked worktree alone", () => {
	const locked = cut("locked-agent");
	git(main, "worktree", "lock", "--reason", "claude agent", locked);

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe("");
	expect(registered()).toContain(locked);
});

it("turns away a pass while another holds the reap lock", () => {
	const landed = cut("landed-work");
	const holder = holdProcess(tmp, "session-checkout.js");
	fs.writeFileSync(path.join(main, ".git", "wfc-reap.pid"), `${holder}\n`);

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe(
		`session checkout: a reap pass is running already (pid ${holder})\n`,
	);
	expect(fs.existsSync(landed)).toBe(true);
});

it("prunes and sweeps strays but judges no worktree where the landing module is off", () => {
	const landed = cut("landed-work");
	const stray = worktree("probe-leftover");
	fs.mkdirSync(stray);

	vi.setSystemTime(Date.now() + HOUR);
	const r = run(["reap"], { WFC_MODULES: "" });

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toBe(
		"session checkout: removed unregistered directory: probe-leftover\n",
	);
	expect(fs.existsSync(landed)).toBe(true);
	expect(fs.existsSync(stray)).toBe(false);
	expect(fs.readdirSync(stores())).toHaveLength(1);
});

it("exits 1 naming what it could not remove, and says where a failed fetch leaves origin/landing", () => {
	const stuck = worktree("stuck-leftover");
	fs.mkdirSync(stuck, { recursive: true });
	git(main, "remote", "set-url", "origin", path.join(tmp, "gone.git"));
	fs.chmodSync(worktrees(), 0o555);

	const r = reap();
	fs.chmodSync(worktrees(), 0o755);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain(
		"session checkout: fetching landing failed, so origin/landing may be stale and read more work as unlanded: ",
	);
	expect(r.stderr).toContain(`session checkout: could not reap ${stuck}: `);
	expect(r.stderr).toContain(
		"session checkout: failed: 1 item could not be reaped, named above — clear what each names; the next pass tries again",
	);
	expect(fs.existsSync(stuck)).toBe(true);
});

it("names a stranded worktree's orphaned-edit issue in place of its ways out (#4439)", () => {
	const dirty = cut("filed-work");
	fs.writeFileSync(path.join(dirty, "half.txt"), "half done");
	const filed = path.join(
		git(main, "rev-parse", "--path-format=absolute", "--git-common-dir"),
		FILED_DIR,
	);
	fs.mkdirSync(filed, { recursive: true });
	const label = worktreeLabel(main, fs.realpathSync(dirty));
	fs.writeFileSync(
		path.join(filed, markerName({ worktree: label, state: "s" })),
		JSON.stringify({ ref: "https://github.com/o/r/issues/9", at: 1 }),
	);

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toMatch(
		/stranded: filed-work — 1 uncommitted path; .* — its orphaned-edit issue https:\/\/github\.com\/o\/r\/issues\/9 carries the decision/,
	);
	expect(r.stderr).not.toContain("git worktree remove --force");
});

it("reads a stranded worktree's idle time from its own last write, never from the reaper's status read", () => {
	const dirty = cut("old-work");
	const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);
	fs.writeFileSync(path.join(dirty, "half.txt"), "half done");
	git(dirty, "add", "half.txt");
	const index = path.join(
		git(dirty, "rev-parse", "--absolute-git-dir"),
		"index",
	);
	fs.utimesSync(index, hoursAgo(5), hoursAgo(5));
	fs.writeFileSync(path.join(dirty, "half.txt"), "more");
	fs.utimesSync(path.join(dirty, "half.txt"), hoursAgo(5), hoursAgo(5));
	execFileSync(
		"git",
		[
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"--allow-empty",
			"-qm",
			"five hours old",
		],
		{
			cwd: dirty,
			env: { ...process.env, GIT_COMMITTER_DATE: hoursAgo(5).toISOString() },
		},
	);
	fs.utimesSync(index, hoursAgo(5), hoursAgo(5));

	const r = reap();

	expect(r.stderr).toContain("idle 6h; last commit ");
});

it("removes a landed worktree whose store link an adopter's directory-only ignore shows untracked, leaving the store", () => {
	const landed = cut("adopter-work");
	const store = path.dirname(
		fs.realpathSync(path.join(landed, "node_modules")),
	);
	fs.writeFileSync(
		path.join(main, ".gitignore"),
		"node_modules/\n.claude/worktrees/\n",
	);
	commitIn(main, ".gitignore", "directory-only ignore");
	git(main, "push", "-q", "origin", "HEAD:landing");
	git(landed, "fetch", "-q", "origin");
	git(landed, "checkout", "-q", "--detach", "origin/landing");
	const keeper = cut("keeps-the-store");
	fs.writeFileSync(path.join(keeper, "half.txt"), "keeps it standing");

	const r = reap();

	expect(r.stderr).toContain("removed landed worktree: adopter-work");
	expect(fs.existsSync(landed)).toBe(false);
	expect(fs.existsSync(path.join(store, "node_modules", "lock"))).toBe(true);
});

it("leaves an unregistered directory a live process works in", () => {
	const busy = worktree("probe-in-use");
	fs.mkdirSync(busy, { recursive: true });
	holdProcess(busy);

	const r = reap();

	expect(r.status, r.stderr).toBe(0);
	expect(fs.existsSync(busy)).toBe(true);
});

it("keeps a landed, clean worktree whose job finished under 3 days ago, and records one finished 3 days ago before removing it (#4368)", () => {
	const recent = cut("recent-finish");
	const undated = cut("undated-finish");
	const old = cut("old-finish");
	const oldHead = git(old, "rev-parse", "HEAD");
	recordJob("j1", recent, "done", Date.now());
	recordJob("j3", undated, "done");
	recordJob("j2", path.join(old, "sub"), "failed", Date.now() - 2 * HOUR);

	const r = reap(3 * DAY - HOUR);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stderr).toContain("removed landed worktree: old-finish");
	expect(registered()).toEqual(expect.arrayContaining([recent, undated]));
	expect(registered()).toHaveLength(3);
	const lines = fs
		.readFileSync(path.resolve(main, reapedRecord()), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
	expect(lines).toEqual([
		{
			job: "j2",
			seat,
			path: old,
			head: oldHead,
			at: expect.any(String),
		},
	]);
});

it("removes a landed tree no job names with no record line, and leaves a tree standing where its record cannot be written", () => {
	const unnamed = cut("no-job");
	const named = cut("named-job");
	recordJob("j1", named, "done", Date.now() - 4 * DAY);
	const record = path.resolve(main, reapedRecord());
	fs.mkdirSync(record);

	const r = reap(4 * DAY);

	expect(r.status).toBe(1);
	expect(r.stderr).toContain("removed landed worktree: no-job");
	expect(r.stderr).toContain(`could not reap ${named}`);
	expect(registered()).toEqual([main, named]);
	fs.rmdirSync(record);
	expect(fs.existsSync(unnamed)).toBe(false);
});

describe("reopen", () => {
	let claudeStub: string;
	let attachLog: string;

	beforeEach(() => {
		claudeStub = path.join(tmp, "claude");
		attachLog = path.join(tmp, "attach.log");
		fs.writeFileSync(
			claudeStub,
			`#!/bin/sh\necho "$CLAUDE_CONFIG_DIR $*" >> ${attachLog}\nexit 3\n`,
		);
		fs.chmodSync(claudeStub, 0o755);
	});

	const reopen = (id: string) =>
		run(["reopen", id], { WFC_CLAUDE_BIN: claudeStub });
	const attached = () => fs.readFileSync(attachLog, "utf8").trim();

	it("rebuilds a removed worktree at its recorded sha with its store linked, then attaches the job on its seat", () => {
		const tree = cut("reopen-me");
		commitIn(tree, "done.txt", "landed work");
		git(tree, "push", "-q", "origin", "HEAD:landing");
		const head = git(tree, "rev-parse", "HEAD");
		recordJob("abc123", tree, "done", Date.now() - 4 * DAY);
		expect(reap().status).toBe(0);
		expect(fs.existsSync(tree)).toBe(false);
		/* The record, not origin/landing, names the sha. */
		const later = cut("later-work");
		commitIn(later, "later.txt", "after the reap");
		git(later, "push", "-q", "origin", "HEAD:landing");

		const r = reopen("abc123");

		expect(r.status, r.stderr).toBe(3);
		expect(r.stderr).toContain(`rebuilt ${tree} at its recorded sha`);
		expect(git(tree, "rev-parse", "HEAD")).toBe(head);
		expect(fs.readFileSync(path.join(tree, "done.txt"), "utf8")).toBe(
			"landed work",
		);
		expect(fs.lstatSync(path.join(tree, "node_modules")).isSymbolicLink()).toBe(
			true,
		);
		expect(attached()).toBe(`${seat} attach abc123`);
	});

	it("only attaches where the worktree still stands", () => {
		const tree = cut("still-here");
		recordJob("def456", tree, "done", Date.now());

		const r = reopen("def456");

		expect(r.status, r.stderr).toBe(3);
		expect(r.stderr).toContain(`${tree} is still there`);
		expect(attached()).toBe(`${seat} attach def456`);
	});

	it("refuses a job whose directory is gone with no record to rebuild it from, attaching nothing", () => {
		recordJob("gone77", worktree("never-recorded"), "done");

		const r = reopen("gone77");

		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`job gone77's directory ${worktree("never-recorded")} is gone and the reaper recorded no sha for it, so nothing can rebuild it`,
		);
		expect(fs.existsSync(attachLog)).toBe(false);
	});

	it("refuses a job no seat holds and no record names, attaching nothing", () => {
		const r = reopen("nope99");

		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"no seat holds job nope99 and the reaper recorded no worktree for it — check the id against `claude agents`",
		);
		expect(fs.existsSync(attachLog)).toBe(false);
	});
});
