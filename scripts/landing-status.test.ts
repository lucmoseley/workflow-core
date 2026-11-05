// @vitest-environment node
/*
 * scripts/landing-status.js end to end (#2407), on a fixture remote.
 *
 * Loosen it and a session reports a queued commit as landed, misses the revert
 * the lander pushed onto its work, or claims a state off refs it never fetched.
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

const runStatus = (modules = "landing", args = ["--session", SESSION]) =>
	runInProcess(STATUS, args, {
		cwd: work,
		env: { ...process.env, WFC_MODULES: modules, CLAUDE_PROJECT_DIR: work },
	});

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-status-"));
	remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, "init", "-q", "--bare", "-b", "main", remote);
	git(tmp, "clone", "-q", remote, work);
	git(work, "config", "user.email", "t@t");
	git(work, "config", "user.name", "t");
	commit("seed");
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
});

afterEach(() => {
	fs.rmSync(path.dirname(core.paths.commitLedger(SESSION, work)), {
		recursive: true,
		force: true,
	});
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("reads a landed, a queued and a reverted commit, naming the revert's sha, after fetching", () => {
	const landed = commit("landed");
	git(work, "push", "-q", "origin", "HEAD:main", "HEAD:landing");
	const reverted = commit("broken");
	git(work, "revert", "--no-edit", reverted);
	const revert = git(work, "rev-parse", "HEAD");
	const queued = commit("queued");
	const unpushed = commit("unpushed");
	git(work, "push", "-q", "origin", `${queued}:landing`);
	/* Local tracking refs stale: only a fetch shows the push above. */
	git(work, "update-ref", "refs/remotes/origin/landing", landed);
	ledger(landed, reverted, queued, unpushed);

	const r = runStatus();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean)).toEqual([
		`landed: ${landed.slice(0, 9)} landed — on main`,
		`reverted by ${revert.slice(0, 9)}: ${reverted.slice(0, 9)} broken`,
		`queued: ${queued.slice(0, 9)} queued — on landing, not yet on main`,
		`unpushed: ${unpushed.slice(0, 9)} unpushed — not on landing`,
	]);
});

it("says the remote could not be read and claims no state", () => {
	ledger(commit("work"));
	git(work, "remote", "set-url", "origin", path.join(tmp, "gone.git"));

	const r = runStatus();

	expect(r.status).toBe(1);
	expect(r.stderr).toMatch(/could not read origin's main and landing/);
	expect(r.stderr).toMatch(/No state claimed\./);
	expect(r.stderr).toMatch(/Check `git fetch origin` works/);
	expect(r.stdout).toBe("");
});

it("leaves out a commit an amend replaced, reporting its replacement", () => {
	const old = commit("work");
	git(work, "commit", "-q", "--amend", "-m", "work amended");
	const amended = git(work, "rev-parse", "HEAD");
	git(work, "push", "-q", "origin", "HEAD:landing");
	ledger(old, amended);

	const r = runStatus();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout.split("\n").filter(Boolean)).toEqual([
		`queued: ${amended.slice(0, 9)} work amended — on landing, not yet on main`,
	]);
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
