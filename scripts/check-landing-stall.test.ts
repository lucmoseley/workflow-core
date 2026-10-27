// @vitest-environment node
/*
 * check-landing-stall.js at session start (#2406, spec #2261, #2692), over a
 * fixture remote whose commits carry chosen committer times and a heartbeat
 * written by hand.
 *
 * Loosen it and a stalled or dead lander holds every landing back with no
 * session told, or a repo with the module off hears of a queue it never ran.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const CHECK = path.resolve(__dirname, "check-landing-stall.js");
const MIN = 60 * 1000;

let tmp: string;
let work: string;

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	}).trim();

const queue = (name: string, ago: number) => {
	fs.writeFileSync(path.join(work, name), name);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-qm", name], {
		GIT_COMMITTER_DATE: new Date(Date.now() - ago).toISOString(),
	});
	git(work, ["push", "-q", "origin", "HEAD:landing"]);
};

/** A heartbeat `ago` ms old, from a pid that has exited. */
const beat = (ago: number, movedAt?: number) => {
	const dir = path.join(work, ".claude", "tmp", "markers");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".lander-heartbeat.json"),
		JSON.stringify({
			pid: spawnSync("true").pid,
			at: new Date(Date.now() - ago).toISOString(),
			batch: null,
			...(movedAt === undefined
				? {}
				: { movedAt: new Date(Date.now() - movedAt).toISOString() }),
		}),
	);
};

const check = (modules = "landing") => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_MODULES: modules,
		CLAUDE_PROJECT_DIR: work,
		WFC_LANDER_START_GRACE_MS: "0",
	};
	delete env.WFC_NOTIFY_PERSIST;
	return runInProcess(CHECK, ["--notify"], { cwd: work, env });
};

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-stall-"));
	const remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, ["init", "-q", "--bare", "-b", "main", remote]);
	git(tmp, ["clone", "-q", remote, work]);
	git(work, ["config", "user.email", "t@t"]);
	git(work, ["config", "user.name", "t"]);
	queue("seed", 0);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** `main` moved to a commit made `ago` ms back. */
const mainAt = (ago: number) => {
	queue("main", ago);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
};

it("warns of a stall where landing is ahead and main's tip is over 2 h old with no move recorded", () => {
	mainAt(121 * MIN);
	queue("new", MIN);
	beat(0);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("LANDING-STALLED");
	expect(r.stdout).toContain(
		"Run the lander by hand to see where it stops: node scripts/lander.js run",
	);
	expect(r.stdout).toContain(
		`with landing ${git(work, ["rev-parse", "--short=9", "HEAD"])} ahead of it`,
	);
	expect(r.stdout).not.toContain("LANDER-DEAD");
});

it("warns of no stall where the heartbeat records a move within 2 h, though main's tip is older", () => {
	mainAt(5 * 60 * MIN);
	queue("new", MIN);
	beat(0, 30 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("warns of nothing where main moved recently and the lander beats", () => {
	queue("new", MIN);
	beat(0);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("warns of a dead lander where its heartbeat is stale while landing is ahead", () => {
	queue("new", MIN);
	beat(30 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("LANDER-DEAD");
	expect(r.stdout).toContain(
		"Run the lander by hand to see where it stops: node scripts/lander.js run",
	);
	expect(r.stdout).not.toContain("LANDING-STALLED");
});

it("warns of no dead lander on a stale heartbeat while landing equals main", () => {
	beat(30 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("prints nothing with the landing module off", () => {
	mainAt(121 * MIN);
	queue("new", MIN);

	const r = check("suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
});
