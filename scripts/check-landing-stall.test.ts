// @vitest-environment node
/*
 * check-landing-stall.js at session start (#2406, #2692, #4458), over a
 * fixture remote whose commits carry chosen committer times and a queue
 * lander heartbeat written by hand.
 *
 * Loosen it and a stalled or dead queue lander holds every landing back with
 * no session told, or a repo with the module off hears of a queue it never
 * ran.
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
let uptimeS: string;

const git = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	}).trim();

/** A commit made `ago` ms back on `work`'s HEAD. */
const commit = (name: string, ago: number) => {
	fs.writeFileSync(path.join(work, name), name);
	git(work, ["add", "-A"]);
	git(work, ["commit", "-qm", name], {
		GIT_COMMITTER_DATE: new Date(Date.now() - ago).toISOString(),
	});
};

/** A queue ref at a commit made `ago` ms back, with no queue log row. */
const queueRef = (name: string, ago: number) => {
	commit(name, ago);
	git(work, ["push", "-q", "origin", `HEAD:refs/heads/queue/${name}`]);
	git(work, ["reset", "-q", "--hard", "origin/main"]);
};

const markers = () => path.join(work, ".claude", "tmp", "markers");

const writeMarker = (name: string, body: object) => {
	fs.mkdirSync(markers(), { recursive: true });
	fs.writeFileSync(path.join(markers(), name), JSON.stringify(body));
};

/** A queue lander heartbeat `ago` ms old, from a pid that has exited. */
const beat = (ago: number) =>
	writeMarker(".queue-lander-heartbeat.json", {
		pid: spawnSync("true").pid,
		at: new Date(Date.now() - ago).toISOString(),
		batch: null,
	});

const check = (modules = "landing") => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		WFC_MODULES: modules,
		CLAUDE_PROJECT_DIR: work,
		WFC_LANDER_START_GRACE_MS: "0",
		WFC_UPTIME_S: uptimeS,
	};
	delete env.WFC_NOTIFY_PERSIST;
	return runInProcess(CHECK, ["--notify"], { cwd: work, env });
};

beforeEach(() => {
	uptimeS = "86400";
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "landing-stall-"));
	const remote = path.join(tmp, "remote.git");
	work = path.join(tmp, "work");
	git(tmp, ["init", "-q", "--bare", "-b", "main", remote]);
	git(tmp, ["clone", "-q", remote, work]);
	git(work, ["config", "user.email", "t@t"]);
	git(work, ["config", "user.name", "t"]);
	commit("seed", 0);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** `main` moved to a commit made `ago` ms back. */
const mainAt = (ago: number) => {
	commit("main", ago);
	git(work, ["push", "-q", "origin", "HEAD:main"]);
};

const HINT =
	"Run the queue lander by hand to see where it stops: node scripts/queue-lander.js run";

it("warns of a stall where a queue ref has waited and main has stood over 2 h, naming both", () => {
	mainAt(8 * 60 * MIN);
	queueRef("old", 121 * MIN);
	beat(0);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("LANDING-STALLED");
	expect(r.stdout).toContain(
		`with queue/old ${git(work, ["rev-parse", "--short=9", "origin/queue/old"])} waiting since`,
	);
	expect(r.stdout).toContain(HINT);
	expect(r.stdout).not.toContain("LANDER-DEAD");
});

it("warns of no stall where the machine booted within 2 h, though the queue ref has waited longer (#4055)", () => {
	mainAt(8 * 60 * MIN);
	queueRef("old", 8 * 60 * MIN);
	beat(0);
	uptimeS = "37";

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).not.toContain("LANDING-STALLED");
});

const HOUR_S = 3600;
const startedAgo = () => Date.now() - Number(uptimeS) * 1000;

it("warns of no stall on the reading that finds the machine has slept since the last, then dates the wake from it (#4055)", () => {
	mainAt(8 * 60 * MIN);
	queueRef("old", 8 * 60 * MIN);
	beat(0);
	uptimeS = String(30 * HOUR_S);
	writeMarker(".machine-wake.json", {
		startedAt: startedAgo() - 8 * HOUR_S * 1000,
		wokeAt: startedAgo() - 8 * HOUR_S * 1000,
	});
	const before = Date.now();

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).not.toContain("LANDING-STALLED");
	const rec = JSON.parse(
		fs.readFileSync(path.join(markers(), ".machine-wake.json"), "utf8"),
	);
	expect(rec.wokeAt).toBeGreaterThanOrEqual(before);
});

it("warns of a stall where the machine woke over 2 h ago and has not slept since (#4055)", () => {
	mainAt(8 * 60 * MIN);
	queueRef("old", 8 * 60 * MIN);
	beat(0);
	uptimeS = String(30 * HOUR_S);
	writeMarker(".machine-wake.json", {
		startedAt: startedAgo(),
		wokeAt: Date.now() - 121 * MIN,
	});

	expect(check().stdout).toContain("LANDING-STALLED");
});

it("warns of no stall where the oldest queue ref was pushed within 2 h, though main has stood longer (#3303)", () => {
	mainAt(8 * 60 * MIN);
	queueRef("new", 10 * MIN);
	beat(0);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("warns of no stall where the queue log's land row is within 2 h, though main's tip is older", () => {
	mainAt(5 * 60 * MIN);
	queueRef("old", 5 * 60 * MIN);
	beat(0);
	writeMarker(".queue-log.jsonl", {
		at: new Date(Date.now() - 30 * MIN).toISOString(),
		event: "land",
		ref: "refs/heads/queue/earlier",
		sha: "c".repeat(40),
	});

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).not.toContain("LANDING-STALLED");
});

it("names a dead lander where a queue ref waits and no markers directory exists yet", () => {
	queueRef("new", MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("LANDER-DEAD");
});

it("warns of nothing where main moved recently and the lander beats", () => {
	queueRef("new", MIN);
	beat(0);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("warns of a dead lander where its heartbeat is stale while a queue ref waits", () => {
	queueRef("new", MIN);
	beat(30 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("LANDER-DEAD");
	expect(r.stdout).toContain(HINT);
	expect(r.stdout).not.toContain("LANDING-STALLED");
});

it("warns of nothing on a stale heartbeat and an old main where no queue ref waits", () => {
	mainAt(8 * 60 * MIN);
	beat(30 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toBe("");
});

it("prints nothing with the landing module off", () => {
	mainAt(8 * 60 * MIN);
	queueRef("old", 121 * MIN);

	const r = check("suites");

	expect(r.status).toBe(0);
	expect(r.stdout).toBe("");
});

it("warns of the oldest queue ref waiting past the 60 min floor, timed from its tip with no log row", () => {
	beat(0);
	queueRef("fresh", 5 * MIN);
	queueRef("old", 61 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).toContain("QUEUE-STALLED — queue/old has waited 1 h 1 min");
	expect(r.stdout).toContain(HINT);
	expect(r.stdout).not.toContain("QUEUE-DEEP");
	expect(r.stdout).not.toContain("LANDING-STALLED");
});

it("warns of no queue finding where every queue ref is within its limits", () => {
	beat(0);
	queueRef("fresh", 5 * MIN);

	const r = check();

	expect(r.status, r.stderr).toBe(0);
	expect(r.stdout).not.toContain("QUEUE-");
});

it("reports a queue log it cannot read as a broken check, never a quiet queue", () => {
	queueRef("new", MIN);
	beat(0);
	fs.mkdirSync(path.join(markers(), ".queue-log.jsonl"));

	const r = check();

	expect(r.stdout).not.toBe("");
	expect(r.stdout).toMatch(/EISDIR/);
});
