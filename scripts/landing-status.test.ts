// @vitest-environment node
/*
 * scripts/landing-status.js end to end (#2407), on a fixture remote.
 *
 * Loosen it and a session reports a queued commit as landed, a commit on its
 * own queue ref as unpushed, misses the revert the lander pushed onto its
 * work, or claims a state off refs it never fetched.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import core from "./lib/arbiter-core.js";
import { runInProcess } from "./lib/run-in-process.js";

const STATUS = path.resolve(__dirname, "../scripts/landing-status.js");
const SESSION = "landing-status-test-session";

let tmp: string;
let work: string;
let remote: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (message: string) => {
	fs.writeFileSync(path.join(work, `${message}.txt`), message);
	git(work, "add", "-A");
	git(work, "commit", "-qm", message);
	return git(work, "rev-parse", "HEAD");
};

const ledger = (...shas: string[]) => {
	const file = core.paths.commitLedger(SESSION, work);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, shas.map((s) => `${s}\n`).join(""));
};

const NOW = Date.parse("2026-11-06T12:00:00Z");
const NO_QUEUE =
	"queue: none waiting; nothing landed or dropped in 7 days; depth p90 none.";

const runStatus = (
	modules = "landing",
	args = ["--session", SESSION],
	cwd = work,
) =>
	runInProcess(STATUS, args, {
		cwd,
		env: {
			...process.env,
			WFC_MODULES: modules,
			CLAUDE_PROJECT_DIR: work,
			WFC_NOW: new Date(NOW).toISOString(),
		},
	});

/** A canned queue log of `[minutes before NOW, event, queue name, sha]`. */
const queueLog = (...rows: [number, string, string, string][]) => {
	const dir = path.join(work, ".claude", "tmp", "markers");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".queue-log.jsonl"),
		rows
			.map(([min, event, name, sha]) =>
				JSON.stringify({
					at: new Date(NOW - min * 60_000).toISOString(),
					event,
					ref: `refs/heads/queue/${name}`,
					sha,
				}),
			)
			.join("\n"),
	);
};

const markers = () => path.join(work, ".claude", "tmp", "markers");

/** A session worktree `queue/<name>` names, cut off HEAD a day before NOW. */
const worktree = (name: string) => {
	const tree = path.join(work, ".claude", "worktrees", name);
	git(work, "worktree", "add", "-q", "--detach", tree);
	const made = (NOW - 24 * 60 * 60_000) / 1000;
	fs.utimesSync(path.join(tree, ".git"), made, made);
	return tree;
};

const short = (sha: string) => sha.slice(0, 9);

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-status-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	git(work, "config", "user.email", "t@t");
	git(work, "config", "user.name", "t");
	commit("seed");
	git(work, "push", "-q", "origin", "HEAD:main");
});

afterEach(() => {
	fs.rmSync(path.dirname(core.paths.commitLedger(SESSION, work)), {
		recursive: true,
		force: true,
	});
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("reads a landed, a queued and a reverted commit, naming the revert's sha, after fetching", () => {
	const tree = worktree("s");
	const landed = commit("landed");
	git(work, "push", "-q", "origin", "HEAD:main");
	const reverted = commit("broken");
	git(work, "revert", "--no-edit", reverted);
	const revert = git(work, "rev-parse", "HEAD");
	const queued = commit("queued");
	const unpushed = commit("unpushed");
	git(
		work,
		"push",
		"-q",
		"origin",
		`${queued}:refs/heads/queue/s`,
		`${revert}:main`,
	);
	/* Local tracking ref stale: only a fetch shows the push above. */
	git(work, "update-ref", "refs/remotes/origin/queue/s", landed);
	ledger(landed, reverted, queued, unpushed);

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean).slice(0, 4)).toEqual([
		`landed: ${landed.slice(0, 9)} landed — on main`,
		`reverted by ${revert.slice(0, 9)}: ${reverted.slice(0, 9)} broken`,
		`queued: ${queued.slice(0, 9)} queued — on queue/s, not yet on main`,
		`unpushed: ${unpushed.slice(0, 9)} unpushed — not pushed to queue/s`,
	]);
});

it("reads a commit as landed once the lander deleted its landed queue ref, the fetch pruning it", () => {
	const tree = worktree("s");
	const landed = commit("landed");
	git(work, "push", "-q", "origin", "HEAD:main");
	/* The tracking ref of a queue ref the lander has since deleted. */
	git(work, "update-ref", "refs/remotes/origin/queue/s", landed);
	const unpushed = commit("unpushed");
	ledger(landed, unpushed);

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean).slice(0, 2)).toEqual([
		`landed: ${landed.slice(0, 9)} landed — on main`,
		`unpushed: ${unpushed.slice(0, 9)} unpushed — not pushed to queue/s`,
	]);
	expect(git(work, "for-each-ref", "refs/remotes/origin/queue/")).toBe("");
});

it("says the remote could not be read and claims no state", () => {
	ledger(commit("work"));
	git(work, "remote", "set-url", "origin", path.join(tmp, "gone.git"));

	const r = runStatus();

	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/could not read origin's main and queue refs/);
	expect(r.stderr).toMatch(/No state claimed\./);
	expect(r.stderr).toMatch(/Check `git fetch origin` works/);
	expect(r.stdout).toBe("");
});

it("leaves out a commit an amend replaced, reporting its replacement", () => {
	const tree = worktree("s");
	const old = commit("work");
	git(work, "commit", "-q", "--amend", "-m", "work amended");
	const amended = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/queue/s");
	ledger(old, amended);

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").find(Boolean)).toBe(
		`queued: ${amended.slice(0, 9)} work amended — on queue/s, not yet on main`,
	);
	expect(r.stdout).not.toContain(old.slice(0, 9));
});

it("ends on the queue's line: the refs waiting, the oldest's wait and the 7-day figures off the queue log", () => {
	const sha = commit("waiting");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/queue/alpha");
	queueLog(
		[100, "enqueue", "gone", "0".repeat(40)],
		[70, "land", "gone", "0".repeat(40)],
		[42, "enqueue", "alpha", sha],
	);
	ledger();

	const r = runStatus();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean)).toEqual([
		`Session ${SESSION} made no commit here.`,
		"queue: 1 waiting, the oldest queue/alpha for 0 h 42 min; time in queue over 7 days p50 0 h 30 min, p90 0 h 30 min across 1 landed or dropped; depth p90 1.",
	]);
});

it("dates a queue ref pushed again from its earliest pending push", () => {
	const first = commit("first");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/queue/alpha");
	const again = commit("again");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/queue/alpha");
	queueLog([90, "enqueue", "alpha", first], [5, "enqueue", "alpha", again]);
	ledger();

	const r = runStatus();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(/the oldest queue\/alpha for 1 h 30 min;/);
});

it("says so where the session made no commit", () => {
	ledger();

	const r = runStatus();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(/made no commit here/);
});

it("says the repo lands straight on main where the landing module is off, with or without a session id", () => {
	ledger(commit("work"));

	const r = runStatus("");

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toMatch(/lands straight on main/);
	expect(r.stdout).not.toMatch(/landed:|queued:|reverted by|unpushed:/);
	const bare = runStatus("", []);
	expect(bare.status, bare.stderr).toBe(0);
	expect(bare.stdout).toMatch(/lands straight on main/);
});

it("refuses to run with no session id, naming --session as the way out", () => {
	const env: NodeJS.ProcessEnv = { ...process.env, WFC_MODULES: "landing" };
	delete env.CLAUDE_CODE_SESSION_ID;

	const r = runInProcess(STATUS, [], { cwd: work, env });

	expect(r.status).toBe(2);
	expect(r.stderr).toMatch(/no session id: pass --session <id>/);
});

it("reads the session's own queue ref as queued, before the queue's line", () => {
	const tree = worktree("alpha");
	const sha = commit("waiting");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/queue/alpha");
	queueLog([42, "enqueue", "alpha", sha]);
	ledger();

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean)).toEqual([
		`Session ${SESSION} made no commit here.`,
		`queued: queue/alpha at ${short(sha)} — waiting for the lander's next batch`,
		"queue: 1 waiting, the oldest queue/alpha for 0 h 42 min; nothing landed or dropped in 7 days; depth p90 none.",
	]);
});

it("reads a landed stay with the main sha the green ledger and main's first-parent path name", () => {
	const tree = worktree("alpha");
	const base = git(work, "rev-parse", "HEAD");
	const member = commit("member");
	git(work, "checkout", "-q", "--detach", base);
	git(work, "merge", "-q", "--no-ff", "--no-edit", member);
	const merged = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:main");
	queueLog([60, "enqueue", "alpha", member], [10, "land", "alpha", member]);
	fs.writeFileSync(
		path.join(markers(), ".landing-green-ledger"),
		`${merged} ${new Date(NOW).toISOString()}\n`,
	);
	ledger();

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain(
		`landed: queue/alpha at ${short(member)} — on main at ${short(merged)}\n`,
	);
});

it("reads a dropped stay with its fix ticket and dropped ref off the drop record", () => {
	const tree = worktree("alpha");
	const sha = commit("dropped");
	git(work, "push", "-q", "origin", "HEAD:refs/heads/dropped/alpha");
	queueLog([60, "enqueue", "alpha", sha], [10, "drop", "alpha", sha]);
	fs.writeFileSync(
		path.join(markers(), ".queue-lander-drops.json"),
		JSON.stringify([
			{
				name: "alpha",
				sha,
				ref: "dropped/alpha",
				onto: sha,
				cause: { kind: "conflict", name: "alpha", files: ["a.txt"] },
				ticket: 4999,
				at: NOW - 10 * 60_000,
			},
		]),
	);
	ledger();

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain(
		`dropped: queue/alpha at ${short(sha)} — kept as dropped/alpha, fix ticket #4999\n`,
	);
});

it("adds no per-ref line for a worktree with no queue ref and no queue-log row", () => {
	const tree = worktree("alpha");
	ledger();

	const r = runStatus("landing", ["--session", SESSION], tree);

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean)).toEqual([
		`Session ${SESSION} made no commit here.`,
		NO_QUEUE,
	]);
});
