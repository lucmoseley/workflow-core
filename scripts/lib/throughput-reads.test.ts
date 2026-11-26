// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paths } from "./arbiter-core.js";
import { defineTemplate } from "./git-fixture";
import { queueLanderFiles } from "./lander-files.js";
import { redPathAtRest } from "./lander-records.js";
import { queueHead } from "./landing-refs.js";
import { recordJobs } from "./loop-jobs.js";
import { logQueueEvent, type QueueEvent, queueLogFile } from "./queue-log.js";
import { appendBreakerEvents } from "./refill-breaker.js";
import { readState, type Transition, updateState } from "./refill-state.js";
import { readThroughput, readThroughputWindow } from "./throughput-reads.js";

type SeatedLaunch = import("./refill-breaker.js").BreakerLaunch & {
	copiedFrom?: string;
};

const tickRead = (root: string, since = 0) =>
	readThroughput({
		roots: [root],
		launches: [],
		lookbackOf: () => since,
		now: Date.now(),
	});

const HOUR = 3_600_000;
const HI = Date.parse("2026-11-16T07:00:00Z");
const LO = HI - 24 * HOUR;

function writeJob(
	seat: string,
	jobId: string,
	start: number,
	{ minutes = 30, last = "done" } = {},
) {
	const dir = path.join(seat, "jobs", jobId);
	fs.mkdirSync(dir, { recursive: true });
	const row = (at: number, state: string) =>
		JSON.stringify({ at: new Date(at).toISOString(), state });
	fs.writeFileSync(
		path.join(dir, "timeline.jsonl"),
		`${row(start, "working")}\n${row(start + minutes * 60_000, last)}\n`,
	);
}

const launchOf = (
	seat: string,
	jobId: string,
	over: Partial<SeatedLaunch> = {},
): SeatedLaunch => ({
	root: "/srv/dv",
	issues: [1],
	jobId,
	sessionId: `${jobId}-session`,
	launchedAt: LO,
	finishedAt: LO + HOUR,
	seat,
	...over,
});

let tmp: string;
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "throughput-reads-"));
	fs.mkdirSync(path.join(tmp, "refill"));
	vi.stubEnv("WFC_REFILL_DIR", path.join(tmp, "refill"));
});
afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(tmp, { recursive: true, force: true });
});

const originHistory = defineTemplate((repo) => {
	const env = {
		...process.env,
		GIT_COMMITTER_DATE: `@${Math.floor(Date.now() / 1000) - 30} +0000`,
	};
	const dated = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, env });
	dated("init", "-q", "-b", "main");
	dated("config", "user.email", "test@example.com");
	dated("config", "user.name", "test");
	dated("commit", "-q", "--allow-empty", "-m", "one");
	dated("checkout", "-q", "-b", "side");
	dated("commit", "-q", "--allow-empty", "-m", "side");
	dated("checkout", "-q", "main");
	dated("commit", "-q", "--allow-empty", "-m", "two");
	dated("merge", "-q", "--no-ff", "-m", "merge", "side");
	dated("update-ref", "refs/remotes/origin/main", "HEAD");
	dated("commit", "-q", "--allow-empty", "-m", "unpushed");
});

describe("a checkout's origin/main commits", () => {
	it("reads origin/main's non-merge commits since a time, with their commit times, and none origin/main lacks", () => {
		const repo = originHistory.instantiate(path.join(tmp, "repo"));
		const two = git(repo, "rev-parse", "HEAD~1^1");
		const commits = tickRead(repo).byRoot[repo]?.commits;
		const shas = commits?.map((c) => c.sha);
		expect(shas).toContain(two);
		expect(shas).toHaveLength(3);
		expect(shas).not.toContain(git(repo, "rev-parse", "HEAD~1"));
		expect(
			tickRead(repo, Date.now() + 3_600_000).byRoot[repo]?.commits,
		).toEqual([]);
		const at = commits?.[0]?.at ?? 0;
		expect(Math.abs(at - Date.now())).toBeLessThan(60_000);
	});

	it("is null where git will not answer", () => {
		const none = path.join(tmp, "none");
		expect(tickRead(none).byRoot[none]?.commits).toBeNull();
	});
});

describe("the declared whole-suite command (#5471)", () => {
	it("reads a checkout's commands.test, and none where it declares none or has no config", () => {
		const root = path.join(tmp, "declared");
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		const config = path.join(root, ".claude", "workflow-core.json");
		fs.writeFileSync(
			config,
			JSON.stringify({ contract: 1, commands: { test: "bash test/all.sh" } }),
		);
		expect(tickRead(root).byRoot[root]?.suiteCommand).toBe("bash test/all.sh");
		fs.writeFileSync(config, JSON.stringify({ contract: 1 }));
		expect(tickRead(root).byRoot[root]?.suiteCommand).toBeNull();
		fs.rmSync(config);
		expect(tickRead(root).byRoot[root]?.suiteCommand).toBeNull();
	});
});

describe("the breaker's record", () => {
	it("reads back what was appended, and none where it is absent", () => {
		expect(tickRead(tmp).record).toEqual([]);
		const event = {
			at: new Date().toISOString(),
			repo: "/r",
			event: "open" as const,
			rate: 0.1,
			workingHours: 13,
		};
		appendBreakerEvents([event], () => undefined);
		expect(tickRead(tmp).record).toEqual([event]);
	});

	it("is null where it will not read", () => {
		fs.mkdirSync(path.join(tmp, "refill", ".refill-breaker.jsonl"));
		expect(tickRead(tmp).record).toBeNull();
	});
});

const WORKTREE = "implement-1-abc";

const lander = defineTemplate((dir) => {
	const origin = path.join(dir, "origin.git");
	const repo = path.join(dir, "repo");
	git(dir, "init", "-q", "--bare", "-b", "main", origin);
	fs.mkdirSync(path.join(repo, ".claude", "worktrees", WORKTREE), {
		recursive: true,
	});
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	git(repo, "commit", "-q", "--allow-empty", "-m", "one");
	git(repo, "remote", "add", "origin", origin);
	git(repo, "push", "-q", "origin", "main");
});

const unbornMain = defineTemplate((dir) => {
	git(dir, "init", "-q", "-b", "main");
});

describe("a breaker trial's landing reads (#5300)", () => {
	const repoAt = (name: string) => unbornMain.instantiate(path.join(tmp, name));

	it("reads a session's commits, none where it made none, and null where its ledger will not read", () => {
		const repo = repoAt("repo");
		const l = launchOf(path.join(tmp, "seat"), "j1", { root: repo });
		const read = tickRead(repo);
		expect(read.commitsOf(l)).toEqual([]);
		fs.mkdirSync(paths.commitLedger("j1-session", repo), { recursive: true });
		expect(read.commitsOf(l)).toBeNull();
	});

	it("reads a launch whose job record names no worktree as unread, and one run outside the checkout's worktrees as having no queue ref", () => {
		const repo = repoAt("repo");
		const seat = path.join(tmp, "seat");
		const read = tickRead(repo);
		const l = launchOf(seat, "j1", { root: repo });
		expect(read.queueOf(l)).toEqual({
			state: "unread",
			why: "its job record names no worktree",
		});
		fs.mkdirSync(path.join(seat, "jobs", "j1"), { recursive: true });
		fs.writeFileSync(
			path.join(seat, "jobs", "j1", "state.json"),
			JSON.stringify({ cwd: repo }),
		);
		expect(read.queueOf(l)).toEqual({ state: "gone" });
	});

	function seedLander() {
		const repo = path.join(
			lander.instantiate(path.join(tmp, "lander")),
			"repo",
		);
		const name = WORKTREE;
		const seat = path.join(tmp, "seat");
		fs.mkdirSync(path.join(seat, "jobs", "j1"), { recursive: true });
		fs.writeFileSync(
			path.join(seat, "jobs", "j1", "state.json"),
			JSON.stringify({ cwd: path.join(repo, ".claude", "worktrees", name) }),
		);
		const push = (message: string) => {
			git(repo, "checkout", "-q", "--detach", "main");
			git(repo, "commit", "-q", "--allow-empty", "-m", message);
			git(repo, "push", "-q", "-f", "origin", `HEAD:${queueHead(name)}`);
			return git(repo, "rev-parse", "HEAD");
		};
		const log = (event: QueueEvent, sha: string) =>
			logQueueEvent(queueLogFile(repo), event, {
				ref: queueHead(name),
				sha,
				at: Date.now(),
			});
		const unqueue = () =>
			git(repo, "push", "-q", "origin", `:${queueHead(name)}`);
		const batch = (sha: string) =>
			fs.writeFileSync(
				queueLanderFiles(repo).batch,
				JSON.stringify({
					line: [
						{
							slot: 0,
							members: [{ name, sha, pushedAt: 1 }],
							deferred: [],
							dropped: [],
							onto: git(repo, "rev-parse", "main"),
							integration: null,
							phase: "merging",
							...redPathAtRest(),
						},
					],
					search: null,
					depth: 2,
				}),
			);
		const l = launchOf(seat, "j1", { root: repo });
		return { repo, name, l, push, log, unqueue, batch };
	}

	it("reads a checkout with no queue log as having no rows, so its remote's queue ref decides (#5273)", () => {
		const { repo, l, push } = seedLander();
		expect(fs.existsSync(queueLogFile(repo))).toBe(false);
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "gone" });
		push("mine");
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "waiting" });
	});

	it("reads a queue ref as waiting while it waits, then landed once the lander lands it, reading each checkout's lander once a tick", () => {
		const { repo, l, push, log, unqueue } = seedLander();
		const sha = push("mine");
		log("enqueue", sha);
		const read = tickRead(repo);
		expect(read.queueOf(l)).toEqual({ state: "waiting" });
		log("take", sha);
		log("land", sha);
		unqueue();
		expect(read.queueOf(l)).toEqual({ state: "waiting" });
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "landed" });
	});

	it("reads a stay under test as waiting, a dropped one as gone, and landed where any stay landed", () => {
		const { repo, l, push, log, unqueue, batch } = seedLander();
		const first = push("first");
		log("enqueue", first);
		batch(first);
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "waiting" });
		fs.rmSync(queueLanderFiles(repo).batch);
		log("drop", first);
		unqueue();
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "gone" });
		const second = push("second");
		log("enqueue", second);
		log("land", second);
		unqueue();
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "landed" });
	});

	it("reads a waiting stay as unread, and why, where its batch record is torn or main will not walk", () => {
		const { repo, name, l, push, log, batch } = seedLander();
		const sha = push("mine");
		log("enqueue", sha);
		const why = `queue/${name} at ${sha.slice(0, 7)} is queued, under test or landed, which will not read`;
		fs.writeFileSync(queueLanderFiles(repo).batch, "[{");
		expect(tickRead(repo).queueOf(l)).toEqual({ state: "unread", why });
		batch(sha);
		const read = tickRead(repo);
		expect(read.queueOf(l)).toEqual({ state: "waiting" });
		const main = git(repo, "rev-parse", "main");
		fs.rmSync(
			path.join(repo, ".git", "objects", main.slice(0, 2), main.slice(2)),
		);
		expect(read.queueOf(l)).toEqual({ state: "unread", why });
	});

	it("reads a worktree's queue ref it cannot reach as unread, and why", () => {
		const repo = repoAt("repo");
		const seat = path.join(tmp, "seat");
		const tree = path.join(repo, ".claude", "worktrees", WORKTREE);
		fs.mkdirSync(tree, { recursive: true });
		fs.mkdirSync(path.dirname(queueLogFile(repo)), { recursive: true });
		fs.writeFileSync(queueLogFile(repo), "");
		fs.mkdirSync(path.join(seat, "jobs", "j1"), { recursive: true });
		fs.writeFileSync(
			path.join(seat, "jobs", "j1", "state.json"),
			JSON.stringify({ cwd: tree }),
		);
		expect(
			tickRead(repo).queueOf(launchOf(seat, "j1", { root: repo })),
		).toMatchObject({
			state: "unread",
			why: expect.stringMatching(/^its queue ref will not read: .*origin/),
		});
	});
});

describe("a checkout's loop sessions (#5289)", () => {
	const windowOf = (launches: SeatedLaunch[] = []) =>
		readThroughputWindow({ roots: ["/srv/dv"], launches, lo: LO, hi: HI })[0];
	const hoursOf = (launches: SeatedLaunch[] = []) =>
		windowOf(launches)?.workingHours;
	const ignore = () => undefined;

	it("counts every finished launch in the window once the state has trimmed it to 50", () => {
		const seat = path.join(tmp, "seat");
		const launches = Array.from({ length: 60 }, (_, i) => {
			const start = LO + i * 20 * 60_000;
			writeJob(seat, `j${i}`, start);
			return {
				...launchOf(seat, `j${i}`),
				prompt: "/implement 1",
				launchedAt: start,
				finishedAt: null as number | null,
			};
		});
		const set =
			(next: SeatedLaunch[]): Transition =>
			(st) => ({ ...st, launches: next as never });
		updateState(set(launches), ignore);
		const finished = launches.map((l) => ({
			...l,
			finishedAt: l.launchedAt + 30 * 60_000,
		}));
		updateState(set(finished), ignore);
		updateState(set(finished.slice(-50)), ignore);
		const kept = readState(ignore).launches as unknown as SeatedLaunch[];
		expect(kept).toHaveLength(50);
		expect(hoursOf(kept)).toBe(30);
	});

	it("counts a job's last row only to the end the record gives it", () => {
		const seat = path.join(tmp, "seat");
		writeJob(seat, "killed", HI - 3 * HOUR, { minutes: 0, last: "working" });
		const l = launchOf(seat, "killed", {
			finishedAt: HI - 3 * HOUR + 10 * 60_000,
		});
		recordJobs([], [l], { now: HI, log: ignore });
		expect(hoursOf()).toBeCloseTo(10 / 60);
	});

	it("counts a copy's original job to the copy's start, as well as the copy", () => {
		const seat = path.join(tmp, "seat");
		writeJob(seat, "orig", HI - 2.5 * HOUR, { minutes: 0, last: "working" });
		writeJob(seat, "copy", HI - 2 * HOUR);
		const orig = launchOf(seat, "orig", { finishedAt: null });
		const copy = launchOf(seat, "copy", {
			copiedFrom: "orig",
			pastSessionIds: ["orig-session"],
			finishedAt: null,
		});
		recordJobs([], [orig], { now: HI - 2.5 * HOUR, log: ignore });
		recordJobs([orig], [copy], { now: HI - 2 * HOUR, log: ignore });
		expect(hoursOf([copy])).toBe(1);
	});

	it("counts a launch's current job to its finish, dropping a malformed row", () => {
		const seat = path.join(tmp, "seat");
		const dir = path.join(seat, "jobs", "j1");
		fs.mkdirSync(dir, { recursive: true });
		const row = (at: number) =>
			JSON.stringify({
				at: new Date(at).toISOString(),
				state: "working",
				detail: "",
			});
		fs.writeFileSync(
			path.join(dir, "timeline.jsonl"),
			`${row(HI - 2 * HOUR)}\n{"at":1}\n${row(HI - 1.5 * HOUR)}\n`,
		);
		const l = launchOf(seat, "j1", {
			finishedAt: HI - 1.5 * HOUR + 10 * 60_000,
		});
		expect(hoursOf([l])).toBeCloseTo(0.5 + 10 / 60);
	});

	it("counts a job named by both the record and a launch once, and none of another checkout's", () => {
		const seat = path.join(tmp, "seat");
		writeJob(seat, "j1", HI - 2 * HOUR);
		writeJob(seat, "other", HI - 2 * HOUR);
		const l = launchOf(seat, "j1");
		recordJobs(
			[],
			[l, { root: "/srv/other", seat, jobId: "other", finishedAt: null }],
			{ now: LO, log: ignore },
		);
		expect(hoursOf([l])).toBe(0.5);
	});

	it("counts no hours for a job whose directory is gone", () => {
		const seat = path.join(tmp, "seat");
		expect(hoursOf([launchOf(seat, "gone")])).toBe(0);
	});

	it("counts no hours for a job whose timeline will not stat or read, and names it (#5301)", () => {
		const seat = path.join(tmp, "seat");
		writeJob(seat, "j1", HI - 2 * HOUR);
		writeJob(seat, "j2", HI - 2 * HOUR);
		const dir = path.join(seat, "jobs", "j1");
		const file = path.join(seat, "jobs", "j2", "timeline.jsonl");
		fs.chmodSync(dir, 0o000);
		fs.chmodSync(file, 0o000);
		try {
			const launches = [launchOf(seat, "j1"), launchOf(seat, "j2")];
			expect(windowOf(launches)).toMatchObject({
				workingHours: 0,
				timelinesUnread: [
					expect.stringMatching(/^job j1's timeline \(EACCES/),
					expect.stringMatching(/^job j2's timeline \(EACCES/),
				],
			});
			const read = readThroughput({
				roots: ["/srv/dv"],
				launches,
				lookbackOf: () => LO,
				now: HI,
			});
			expect(read.byRoot["/srv/dv"]).toMatchObject({
				sessions: [],
				timelinesUnread: [
					expect.stringMatching(/^job j1's/),
					expect.stringMatching(/^job j2's/),
				],
			});
		} finally {
			fs.chmodSync(dir, 0o755);
			fs.chmodSync(file, 0o644);
		}
	});

	it("counts the launches alone where the record will not read, and says so", () => {
		const seat = path.join(tmp, "seat");
		writeJob(seat, "j1", HI - 2 * HOUR);
		const l = launchOf(seat, "j1");
		fs.mkdirSync(path.join(tmp, "refill", ".refill-jobs.jsonl"));
		expect(windowOf([l])).toMatchObject({ workingHours: 0.5, jobsRead: false });
		const read = readThroughput({
			roots: ["/srv/dv"],
			launches: [l],
			lookbackOf: () => LO,
			now: HI,
		});
		expect(read.byRoot["/srv/dv"]?.sessions).toHaveLength(1);
	});
});

describe("readThroughputWindow", () => {
	it("reads a served checkout's window: its sessions' hours, its breaker at the end, the window's events", () => {
		const seat = path.join(tmp, "seat");
		const row = (at: number) =>
			JSON.stringify({ at: new Date(at).toISOString(), state: "working" });
		for (const [id, start] of [
			["in", HI - 2 * HOUR],
			["before", LO - 3 * HOUR],
		] as const) {
			fs.mkdirSync(path.join(seat, "jobs", id), { recursive: true });
			fs.writeFileSync(
				path.join(seat, "jobs", id, "timeline.jsonl"),
				`${row(start)}\n${row(start + 30 * 60_000)}\n`,
			);
		}
		const launch = (jobId: string, launchedAt: number, root = "/srv/dv") => ({
			root,
			issues: [1],
			jobId,
			sessionId: jobId,
			launchedAt,
			finishedAt: launchedAt + HOUR,
			seat,
		});
		const ev = (at: number, event: "open" | "reopen", repo = "/srv/dv") => ({
			at: new Date(at).toISOString(),
			repo,
			event,
			rate: 0.1,
			workingHours: 13,
		});
		appendBreakerEvents(
			[
				ev(LO - HOUR, "open"),
				ev(HI - HOUR, "reopen"),
				ev(HI - HOUR, "open", "/srv/other"),
			],
			() => undefined,
			() => HI + HOUR,
		);
		const [dv] = readThroughputWindow({
			roots: ["/srv/dv"],
			launches: [
				launch("in", HI - 2 * HOUR),
				launch("before", LO - 3 * HOUR),
				launch("in", HI - 2 * HOUR, "/srv/other"),
			],
			lo: LO,
			hi: HI,
		});
		expect(dv).toEqual({
			checkout: "dv",
			commits: null,
			workingHours: 1,
			jobsRead: true,
			timelinesUnread: [],
			gateRuns: null,
			state: { state: "open", since: HI - HOUR },
			events: [ev(HI - HOUR, "reopen")],
		});
	});
});
