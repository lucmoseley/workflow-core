// @vitest-environment node
/*
 * Pins which stranded file claims and unanswered release requests the sweep
 * names, past what age, and what it itemises under `--notify`.
 *
 * Every test drives the real script end to end through run-in-process, with a
 * fake `claude` on WFC_CLAUDE_BIN standing in for the daemon.
 *
 * Two properties carry the ruling (mantahostels#318 — expiry refused, this sweep bounds the
 * wedge instead): the sweep NEVER breaks a claim, and it degrades to silence
 * rather than to "dead".
 *
 * It runs in `npm run status` and feeds /pick-next's owed-work count: loosen a
 * case and a claim outliving its session goes unreported, so the next session
 * just finds the file taken, or a live holder is called finished.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, live, locks, store } from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-stranded-file-claims.js");

const sb = freshSandbox((fresh) =>
	fs.mkdirSync(path.join(fresh.dir, "bin"), { recursive: true }),
);

const locksDir = () => store.paths.locksDir();

/*
 * The store's own filename for a claim: a truncated sha256 of the repo-relative
 * path. Duplicated rather than exported, because a fixture writing lock files
 * under a name of its own invention is one the arbiter's writers cannot find.
 */
const lockFile = (rel: string) =>
	`${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`;

/** A lock on disk, in the shape locks.newLock writes. `agedHours` back-dates it. */
function claim(rel: string, sessionId: string, agedHours = 24) {
	fs.mkdirSync(locksDir(), { recursive: true });
	const rec = locks.newLock({
		path: rel,
		sessionId,
		pid: 4242,
		procStart: "111",
	});
	rec.claimedAt = new Date(Date.now() - agedHours * 3_600_000).toISOString();
	fs.writeFileSync(path.join(locksDir(), lockFile(rel)), JSON.stringify(rec));
	return rec;
}

/**
 * A release request on disk, in the shape store.recordRequest writes.
 * `agedHours` back-dates `since`; `declined`/`why` are passed through raw.
 */
function request(
	subject: string,
	requesterId: string,
	holderId: string,
	{
		agedHours = 24,
		declined = null,
		why = null,
	}: { agedHours?: number; declined?: unknown; why?: string | null } = {},
) {
	const me = live(sb, requesterId);
	store.recordRequest(subject, me, holderId, why);
	const file = store.paths.request(store.subjectPath(subject), requesterId);
	const rec = JSON.parse(fs.readFileSync(file, "utf8"));
	rec.since = new Date(Date.now() - agedHours * 3_600_000).toISOString();
	if (declined) rec.declined = declined;
	fs.writeFileSync(file, JSON.stringify(rec));
	return rec;
}

/** Everything the locks directory holds right now, by claim path. */
const locksOnDisk = () =>
	fs
		.readdirSync(locksDir())
		.filter((f) => f.endsWith(".json"))
		.map((f) => fs.readFileSync(path.join(locksDir(), f), "utf8")) as string[];

/** A `claude` stand-in: `agents --json` prints `body`, exits `code`. */
function fakeClaude(body: string, code = 0) {
	const bin = path.join(sb.dir, "bin", "claude");
	fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`);
	fs.chmodSync(bin, 0o755);
	process.env.WFC_CLAUDE_BIN = bin;
	return bin;
}

/*
 * A git repo at the sandbox root, with whatever the tree already holds
 * committed — so a file written AFTER this call is dirty and one written before
 * it is clean.
 */
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
	JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			status: "busy",
			state: "working",
		})),
	);

/* A background session the oracle still lists but has marked done — mantahostels#2765's
 * exact shape: finished but not yet reaped. */
const finishedListing = (...sessionIds: string[]) =>
	JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			kind: "background",
			state: "done",
		})),
	);

/* A background session the oracle still lists but which ended some way other
 * than `done` (mantahostels#2774; https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-state-status-skew.md §F2). */
const endedListing = (state: string, ...sessionIds: string[]) =>
	JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			id: sessionId.slice(0, 8),
			sessionId,
			kind: "background",
			state,
		})),
	);

/* GITHUB_ACTIONS off: these assert on the human report, and check.js writes
 * ::warning:: annotations to stdout when it is set. A `sessionId` is the shape
 * every mid-session caller has; the default is a run from outside a session. */
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

/** Human text is on stderr, except under --notify. */
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
		// WARN, never FAIL: a human decides whether anyone is still working it.
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

	/* mantahostels#2765: a holder the oracle still lists but has marked done is judged like
	 * an unlisted one, not exempted for ever. */
	it("reports a claim whose holder is listed but the oracle calls finished, past the threshold", () => {
		claim("docs/doc-map.md", "finished-session", 30);
		fakeClaude(finishedListing("finished-session"));

		const out = report(run());
		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("STRANDED-CLAIM");
	});

	/* mantahostels#2774: `done` was never the only terminal state. A session the oracle
	 * lists as `failed` or `stopped` has stopped working just as surely. */
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

	/* A background session still WORKING must keep its exemption, or the
	 * widening would call every live holder stranded. */
	it("still says nothing about a listed holder the oracle calls working", () => {
		claim("docs/doc-map.md", "busy-session", 300);
		fakeClaude(endedListing("working", "busy-session"));

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

	/* mantahostels#1692. */
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

	/* mantahostels#1747. */
	it("keeps reporting the standing count under --notify, run after run", () => {
		claim("docs/doc-map.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		for (const _ of [1, 2]) {
			const r = run(["--notify"]);
			expect(r.stdout).toContain("STRANDED-CLAIM (1) standing");
			// Every --notify outcome exits 0 or Claude Code stops showing the hook.
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

	/* A lock holds a claim SUBJECT, and a region claim spells itself
	 * `docs/doc-map.md#B42`, which git has never heard of (mantahostels#1747). */
	it("matches a REGION claim against the file it names", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "doc-map.md"), "edited\n");
		claim("docs/doc-map.md#B42", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		const out = run(["--notify"]).stdout;
		expect(out).toContain("1 of them carries UNCOMMITTED WORK");
		expect(out).toContain("docs/doc-map.md#B42");
	});

	/* The whole reason for `-z`: porcelain v1 C-quotes a path with a space, and
	 * a quoted path never matches the raw one the lock holds. */
	it("matches a claim on a path with a space in it", () => {
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "a note.md"), "edited\n");
		claim("docs/a note.md", "dead-session", 30);
		fakeClaude(agentsListing("live-session"));

		expect(run(["--notify"]).stdout).toContain("docs/a note.md");
	});

	/* A rename spends the next NUL-separated field on its source, so a claim on
	 * the OLD name must still be found. */
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

		// The sandbox repo is not a git repo at all, so `git status` cannot answer.
		const r = run(["--notify"]);
		expect(r.stdout).toContain("STRANDED-CLAIM (1) standing");
		expect(r.stdout).toContain("would not answer");
		expect(r.stdout).not.toContain("docs/doc-map.md");
		expect(r.status).toBe(0);

		// And a hand run says it too, rather than printing a list whose missing
		// annotations read exactly like a clean tree.
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

/* mantahostels#1784, spec mantahostels#1702's story 18: the founder's own escape hatch for a holder
 * that stays idle forever, since the in-band notice at claim/release only
 * fires when the holder next does something. */
describe("an unanswered release request", () => {
	it("names the path, requester, holder and age past the threshold, with the remedy", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
			why: "need it for the B5 entry",
		});

		const r = run();
		const out = report(r);
		expect(out).toContain("UNANSWERED-REQUEST");
		expect(out).toContain("docs/doc-map.md");
		expect(out).toContain("requester-session");
		expect(out).toContain("holder-session");
		expect(out).toContain("20h");
		expect(out).toContain("go to the holder's terminal");
		expect(r.status).toBe(0);
	});

	it("is never reported once the holder has declined it", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
			declined: {
				by: "holder-session",
				at: new Date().toISOString(),
				reason: "still working it",
			},
		});

		expect(report(run())).not.toContain("UNANSWERED-REQUEST");
	});

	it("holds its tongue below the threshold, and speaks above it", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 3,
		});

		expect(report(run())).not.toContain("UNANSWERED-REQUEST");
		expect(report(run(["--hours", "1"]))).toContain("UNANSWERED-REQUEST");
	});

	it("is never reported once its requester has claimed the path", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});
		// The route a real claim takes: cmdClaim drops the requester's own
		// request the moment it lands.
		store.dropRequests("docs/doc-map.md", "requester-session");

		expect(report(run())).not.toContain("UNANSWERED-REQUEST");
	});

	it("is reported under --notify too", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});

		const r = run(["--notify"]);
		expect(r.stdout).toContain("UNANSWERED-REQUEST");
		expect(r.stdout).toContain("docs/doc-map.md");
		expect(r.status).toBe(0);
	});

	it("is reported even when nothing is claimed, since the register is a separate directory", () => {
		// No claim() call at all: locks.length === 0 takes the early return, which
		// must not swallow a standing request too.
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});

		const out = report(run());
		expect(out).toContain("UNANSWERED-REQUEST");
		expect(out).toContain("docs/doc-map.md");
	});

	it("is reported even when the file-claim store cannot be read at all", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});
		fakeClaude(agentsListing("holder-session"));
		// Corrupt the locks directory itself: readLocks() returns null, which
		// takes the ctx.skip() branch — the claims half of the sweep is now
		// unusable, and the request half must still speak.
		fs.rmSync(locksDir(), { recursive: true, force: true });
		fs.writeFileSync(locksDir(), "not a directory");

		const out = report(run());
		expect(out).toContain("UNANSWERED-REQUEST");
		expect(out).toContain("SKIP:");
	});

	it("is reported even when the running-session oracle cannot be read", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});
		fakeClaude("not json");

		const out = report(run());
		expect(out).toContain("UNANSWERED-REQUEST");
		expect(out).toContain("SKIP:");
	});

	it("names UNREADABLE-REQUESTS rather than silently reading zero, when the register itself will not parse", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});
		// Corrupt the requests directory: a plain file where readdirSync expects
		// a directory.
		fs.rmSync(store.paths.requestsDir(), { recursive: true, force: true });
		fs.writeFileSync(store.paths.requestsDir(), "not a directory");

		const out = report(run());
		expect(out).toContain("UNREADABLE-REQUESTS");
		expect(out).not.toContain("UNANSWERED-REQUEST");
	});

	it("reports a request whose `since` will not parse, rather than dropping it", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(agentsListing("holder-session"));
		const rec = request(
			"docs/doc-map.md",
			"requester-session",
			"holder-session",
		);
		const file = store.paths.request("docs/doc-map.md", "requester-session");
		fs.writeFileSync(file, JSON.stringify({ ...rec, since: "not-a-date" }));

		const out = report(run());
		expect(out).toContain("UNANSWERED-REQUEST");
		expect(out).toContain("an unreadable time");
	});
});

describe("it never breaks a claim", () => {
	it("leaves every lock on disk byte-for-byte, stranded ones included", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		claim("CLAUDE.md", "live-session", 500);
		fakeClaude(agentsListing("live-session"));
		const before = locksOnDisk();

		expect(report(run())).toContain("STRANDED-CLAIM");

		expect(locksOnDisk().sort()).toEqual(before.sort());
	});

	it("has no flag that releases anything", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude(agentsListing("live-session"));
		const before = locksOnDisk();

		for (const flag of ["--release", "--break", "--fix", "--force"]) {
			run([flag]);
			expect(locksOnDisk()).toEqual(before);
		}
	});
});

describe("it degrades to silence, never to dead", () => {
	const cases: [string, () => void][] = [
		[
			"the oracle cannot be run at all",
			() => {
				process.env.WFC_CLAUDE_BIN = path.join(sb.dir, "bin", "no-such-claude");
			},
		],
		["it exits non-zero", () => fakeClaude("[]", 3)],
		["it prints something that is not JSON", () => fakeClaude("not json")],
		[
			"it returns an object rather than a list",
			() => fakeClaude('{"agents":[]}'),
		],
		["it lists nothing at all", () => fakeClaude("[]")],
		[
			"its entries carry no session id",
			() => fakeClaude('[{"pid":1,"status":"busy"}]'),
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

	/*
	 * Mid-session, the oracle lists its caller, so a listing that omits it is a
	 * short one — and on a short list a live neighbour's claim would read
	 * stranded. The strict self-test refuses it instead (#1390).
	 */
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

	/* The display names ride on the same oracle read. A sweep that answered
	 * `{ids}` alone would fall back to raw session ids here and nothing else
	 * would notice. */
	it("names a holder by its display name", () => {
		claim("docs/doc-map.md", "holder-session", 30);
		fakeClaude(
			JSON.stringify([
				{ pid: 2, sessionId: "the-sweeps-own-session", state: "working" },
				{
					pid: 1,
					sessionId: "holder-session",
					name: "Implement 1924",
					status: "busy",
					state: "working",
				},
			]),
		);
		request("docs/doc-map.md", "requester-session", "holder-session", {
			agedHours: 20,
		});

		const r = run([], "the-sweeps-own-session");
		expect(report(r)).toContain("Implement 1924");
		expect(r.status).toBe(0);
	});

	it("says nothing under --notify when the oracle is unreadable", () => {
		claim("docs/doc-map.md", "dead-session", 500);
		fakeClaude("not json");

		const r = run(["--notify"]);
		expect(r.stdout.trim()).toBe("");
		expect(r.status).toBe(0);
	});

	it("never calls the oracle when nothing is claimed", () => {
		fakeClaude("not json");
		expect(report(run())).toContain("no files are claimed");
	});
});
