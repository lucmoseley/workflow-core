// @vitest-environment node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentsAnswer,
	buildAgentsBranch,
	buildListedRow,
	buildUnrecordedRow,
} from "./lib/agents-stop-fake";
import { buildLockRecord, freshSandbox, store } from "./lib/arbiter-testkit";
import { writeClaudeStub } from "./lib/claude-stub";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-stranded-file-claims.js");

const sb = freshSandbox((fresh) =>
	fs.mkdirSync(path.join(fresh.dir, "bin"), { recursive: true }),
);

const locksDir = () => store.paths.locksDir();

const lockFile = (rel: string) =>
	`${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`;

function claim(rel: string, sessionId: string, agedHours = 24, tree?: string) {
	fs.mkdirSync(locksDir(), { recursive: true });
	const rec = buildLockRecord({
		path: rel,
		sessionId,
		pid: 4242,
		procStart: "111",
		tree,
	});
	rec.claimedAt = new Date(Date.now() - agedHours * 3_600_000).toISOString();
	fs.writeFileSync(path.join(locksDir(), lockFile(rel)), JSON.stringify(rec));
	return rec;
}

const readLocksOnDisk = () =>
	fs
		.readdirSync(locksDir())
		.filter((f) => f.endsWith(".json"))
		.map((f) => fs.readFileSync(path.join(locksDir(), f), "utf8")) as string[];

function fakeClaude(answer: AgentsAnswer) {
	const bin = writeClaudeStub(path.join(sb.dir, "bin", "claude"), [
		buildAgentsBranch(answer),
	]);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
	return bin;
}

function gitRepo() {
	const git = (...args: string[]) =>
		spawnSync("git", args, { cwd: sb.repo, encoding: "utf8" });
	git("init", "-q");
	git("add", "-A");
	git(
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"seed",
		"--allow-empty",
	);
}

const agentsListing = (...sessionIds: string[]) =>
	sessionIds.map((sessionId, i) =>
		buildListedRow({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			status: "busy",
		}),
	);

const finishedListing = (...sessionIds: string[]) =>
	sessionIds.map((sessionId, i) =>
		buildListedRow({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			state: "done",
		}),
	);

/* A background session the oracle still lists but which ended some way other
 * than `done` (mantahostels#2774; https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F2). */
const endedListing = (state: string, ...sessionIds: string[]) =>
	sessionIds.map((sessionId, i) =>
		buildUnrecordedRow({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			kind: "background",
			state,
		}),
	);

const run = (args: string[] = [], sessionId = "") =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_CODE_SESSION_ID: sessionId,
			CLAUDE_PROJECT_DIR: sb.repo,
		},
		cwd: sb.repo,
	});

const report = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("what it reports", () => {
	it("names the path, the holder and the age of a claim whose holder is gone", () => {
		claim("docs/doc-map.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const r = run();
		const out = report(r);
		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("dead-session");
		expect(out).toContain("held 30h");
		expect(out).toContain("STRANDED-CLAIM");
		expect(r.status).toBe(0);
	});

	it("says nothing about a claim whose holder IS listed", () => {
		claim("docs/doc-map.md", "live-session", 300);
		fakeClaude(agentsListing("live-session"));

		const r = run();
		expect(report(r)).not.toContain("STRANDED-CLAIM");
		expect(report(r)).toContain("OK:");
	});

	it("holds its tongue below the threshold, and speaks above it", () => {
		claim("docs/doc-map.md", "dead-session", 3);
		fakeClaude(agentsListing("live-session"));

		expect(report(run())).not.toContain("STRANDED-CLAIM");
		expect(report(run(["--hours", "1"]))).toContain("docs/doc-map.md");
	});

	// lucmoseley/mantahostels#2765
	it("reports a claim whose holder is listed but the oracle calls finished, past the threshold", () => {
		claim("docs/doc-map.md", "finished-session", 30);
		fakeClaude(finishedListing("finished-session"));

		const out = report(run());
		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("STRANDED-CLAIM");
	});

	// lucmoseley/mantahostels#2774
	it.each(["failed", "stopped"])(
		"reports a claim whose holder the oracle calls %s, past the threshold",
		(state) => {
			claim("docs/doc-map.md", "ended-session", 30);
			fakeClaude(endedListing(state, "ended-session"));

			const out = report(run());
			expect(out).toContain("docs/doc-map.md");
			expect(out).toContain("STRANDED-CLAIM");
		},
	);

	it("still says nothing about a listed holder the oracle calls working", () => {
		claim("docs/doc-map.md", "busy-session", 300);
		fakeClaude([
			buildListedRow(
				{
					pid: 100,
					id: "busy-ses",
					sessionId: "busy-session",
					state: "working",
				},
				["status"],
			),
		]);

		expect(report(run())).not.toContain("STRANDED-CLAIM");
	});

	it("reports a claim whose timestamp will not parse, rather than dropping it", () => {
		const rec = claim("docs/doc-map.md", "dead-session");
		rec.claimedAt = "not-a-date";
		fs.writeFileSync(
			path.join(locksDir(), lockFile("docs/doc-map.md")),
			JSON.stringify(rec),
		);
		fakeClaude(agentsListing("live-session"));

		expect(report(run())).toContain("held since an unreadable time");
	});

	// lucmoseley/mantahostels#1692
	it("names an unparseable record and still judges every claim beside it", () => {
		claim("docs/doc-map.md", "dead-session", 30);
		fs.writeFileSync(path.join(locksDir(), lockFile("AGENTS.md")), "");
		fakeClaude(agentsListing("live-session"));

		const out = report(run());
		expect(out).toContain("UNREADABLE-LOCK");
		expect(out).toContain(lockFile("AGENTS.md"));
		expect(out).toContain("would not parse");
		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("STRANDED-CLAIM");
	});

	// lucmoseley/mantahostels#1747
	it("keeps reporting the standing count under --notify, run after run", () => {
		claim("docs/doc-map.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		for (const _ of [1, 2]) {
			const r = run(["--notify"]);
			expect(r.stdout).toContain("STRANDED-CLAIM (1) standing");
			expect(r.status).toBe(0);
		}
	});

	it("does not itemise a stranded claim under --notify when its file is clean", () => {
		gitRepo();
		claim("docs/doc-map.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);
		expect(r.stdout).toContain("STRANDED-CLAIM (1) standing");
		expect(r.stdout).not.toContain("docs/doc-map.md");
		expect(r.stdout).toContain("None carries uncommitted work");
		expect(r.status).toBe(0);
	});

	it("itemises under --notify exactly the stranded claims carrying uncommitted work", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "doc-map.md"), "edited\n");
		claim("docs/doc-map.md", "dead-session", 30);
		claim("CLAUDE.md", "another-dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);
		expect(r.stdout).toContain("STRANDED-CLAIM (2) standing");
		expect(r.stdout).toContain("1 of them carries UNCOMMITTED WORK");
		expect(r.stdout).toContain("docs/doc-map.md");
		expect(r.stdout).not.toContain("CLAUDE.md");
		expect(r.status).toBe(0);
	});

	// lucmoseley/mantahostels#1747
	it("matches a REGION claim against the file it names", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "doc-map.md"), "edited\n");
		claim("docs/doc-map.md#B42", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const out = run(["--notify"]).stdout;
		expect(out).toContain("1 of them carries UNCOMMITTED WORK");
		expect(out).toContain("docs/doc-map.md#B42");
	});

	it("matches a claim on a path with a space in it", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "a note.md"), "edited\n");
		claim("docs/a note.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		expect(run(["--notify"]).stdout).toContain("docs/a note.md");
	});

	it("matches a claim on the source side of a rename", () => {
		fs.writeFileSync(path.join(sb.repo, "docs", "was.md"), "content\n");
		gitRepo();
		fs.renameSync(
			path.join(sb.repo, "docs", "was.md"),
			path.join(sb.repo, "docs", "now.md"),
		);
		spawnSync("git", ["add", "-A"], { cwd: sb.repo });
		claim("docs/was.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		expect(run(["--notify"]).stdout).toContain("docs/was.md");
	});

	it("itemises nothing and says so when the working tree cannot be read", () => {
		claim("docs/doc-map.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);
		expect(r.stdout).toContain("STRANDED-CLAIM (1) standing");
		expect(r.stdout).toContain("would not answer");
		expect(r.stdout).not.toContain("docs/doc-map.md");
		expect(r.status).toBe(0);

		expect(report(run())).toContain("would not answer");
	});

	it("still reports everything standing when run by hand, annotating the dirty", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "doc-map.md"), "edited\n");
		claim("docs/doc-map.md", "dead-session", 30);
		claim("CLAUDE.md", "another-dead-session", 30);
		fakeClaude(agentsListing("live-session"));
		run(["--notify"]);

		const out = report(run());
		expect(out).toContain("docs/doc-map.md  [uncommitted work]");
		expect(out).toContain("CLAUDE.md");
		expect(out).not.toContain("CLAUDE.md  [uncommitted work]");
	});

	it("prints nothing at all under --notify when every claim is live", () => {
		claim("docs/doc-map.md", "live-session");
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});
});

describe("it never breaks a claim", () => {
	it("leaves every lock on disk byte-for-byte, stranded ones included", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		claim("CLAUDE.md", "live-session", 500);
		fakeClaude(agentsListing("live-session"));
		const before = readLocksOnDisk();

		expect(report(run())).toContain("STRANDED-CLAIM");

		expect(readLocksOnDisk().sort()).toEqual(before.sort());
	});

	it("has no flag that releases anything", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude(agentsListing("live-session"));
		const before = readLocksOnDisk();

		for (const flag of ["--release", "--break", "--fix", "--force"]) {
			run([flag]);
			expect(readLocksOnDisk()).toEqual(before);
		}
	});
});

describe("it degrades to silence, never to dead", () => {
	const cases: [string, () => void][] = [
		[
			"the oracle cannot be run at all",
			() => {
				vi.stubEnv(
					"WFC_CLAUDE_BIN",
					path.join(sb.dir, "bin", "no-such-claude"),
				);
			},
		],
		["it exits non-zero", () => fakeClaude({ exit: 3 })],
		[
			"it prints something that is not JSON",
			() => fakeClaude({ malformed: "not json" }),
		],
		[
			"it returns an object rather than a list",
			() => fakeClaude({ malformed: '{"agents":[]}' }),
		],
		["it lists nothing at all", () => fakeClaude([])],
		[
			"its entries carry no session id",
			() => fakeClaude([buildUnrecordedRow({ pid: 1, status: "busy" })]),
		],
	];

	for (const [what, arrange] of cases)
		it(`reports no staleness when ${what}`, () => {
			claim("docs/doc-map.md", "dead-session", 500);
			arrange();

			const r = run();
			const out = report(r);
			expect(out).not.toContain("STRANDED-CLAIM");
			expect(out).toContain("SKIP:");
			expect(out).toContain("went unjudged");
			expect(r.status).toBe(0);
		});

	it("judges the other claims where the oracle lists the session it runs in", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude(agentsListing("the-sweeps-own-session", "someone-else"));

		const r = run([], "the-sweeps-own-session");
		expect(report(r)).toContain("STRANDED-CLAIM");
		expect(r.status).toBe(0);
	});

	it("judges nothing, and names the omission, where the oracle has not listed the session it runs in", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude(agentsListing("someone-else"));

		const r = run([], "the-sweeps-own-session");
		const out = report(r);
		expect(out).not.toContain("STRANDED-CLAIM");
		expect(out).toContain("does not list this very session");
		expect(out).toContain("went unjudged");
		expect(r.status).toBe(0);
	});

	it("never calls its OWN claim stranded on a listing that omits it", () => {
		claim("docs/doc-map.md", "the-sweeps-own-session", 500);
		fakeClaude(agentsListing("someone-else"));

		const r = run([], "the-sweeps-own-session");
		expect(report(r)).not.toContain("STRANDED-CLAIM");
		expect(r.status).toBe(0);
	});

	it("says nothing under --notify when the oracle is unreadable", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude({ malformed: "not json" });

		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("never calls the oracle when nothing is claimed", () => {
		fakeClaude({ malformed: "not json" });
		expect(report(run())).toContain("no files are claimed");
	});
});

// #4244
describe("a finished session's worktree", () => {
	function worktreeOf(sessionId: string, rel: string, hours: number) {
		gitRepo();
		const wt = path.join(sb.repo, ".claude", "worktrees", "w1");
		fs.mkdirSync(path.dirname(wt), { recursive: true });
		const r = spawnSync("git", ["worktree", "add", "-q", "--detach", wt], {
			cwd: sb.repo,
			encoding: "utf8",
		});
		if (r.status !== 0) throw new Error(r.stderr);
		const job = path.join(sb.home, "jobs", sessionId.slice(0, 8));
		fs.mkdirSync(job, { recursive: true });
		fs.writeFileSync(
			path.join(job, "state.json"),
			JSON.stringify({ sessionId, name: "Worker one", cwd: wt }),
		);
		const file = path.join(wt, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "worktree edit\n");
		const at = new Date(Date.now() - hours * 3_600_000);
		fs.utimesSync(file, at, at);
		return fs.realpathSync(wt);
	}

	it("lists its uncommitted files under that session, with no claim standing", () => {
		worktreeOf("dead-owner-1", "notes/new.md", 30);
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);

		expect(r.stdout).toContain("STRANDED-WORKTREE (1)");
		expect(r.stdout).toContain(
			"Worker one (dead-own) — .claude/worktrees/w1, last written 30h ago",
		);
		expect(r.stdout).toContain("    notes/new.md");
	});

	it("says nothing of one whose session is listed live, or younger than the threshold", () => {
		worktreeOf("live-owner-1", "notes/new.md", 30);
		fakeClaude(agentsListing("live-owner-1"));
		expect(report(run())).not.toContain("STRANDED-WORKTREE");

		fakeClaude(agentsListing("live-session"));
		expect(report(run(["--hours", "40"]))).not.toContain("STRANDED-WORKTREE");
	});

	it("counts a stranded claim as carrying work where its file is dirty in its holder's worktree", () => {
		const wt = worktreeOf("dead-owner-2", "docs/doc-map.md", 30);
		claim("docs/doc-map.md", "dead-owner-2", 30, wt);
		fakeClaude(agentsListing("live-session"));

		const r = run(["--notify"]);

		expect(r.stdout).toContain("1 of them carries UNCOMMITTED WORK");
	});

	it("does not count a main-checkout claim as carrying work for its path's dirt in a worktree (#4457)", () => {
		worktreeOf("dead-owner-2", "docs/doc-map.md", 30);
		claim("docs/doc-map.md", "dead-owner-2", 30);
		fakeClaude(agentsListing("live-session"));

		expect(run(["--notify"]).stdout).not.toContain("UNCOMMITTED WORK");
	});

	it("names a registration whose directory has gone rather than calling it clean", () => {
		worktreeOf("dead-owner-3", "notes/new.md", 30);
		fs.rmSync(path.join(sb.repo, ".claude", "worktrees", "w1"), {
			recursive: true,
			force: true,
		});
		fakeClaude(agentsListing("live-session"));

		expect(report(run())).toContain(
			"1 registered worktree(s) git would not read went unjudged",
		);
	});
});
