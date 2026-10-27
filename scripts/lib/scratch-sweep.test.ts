// @vitest-environment node
/*
 * scratch-sweep.js's own suite — the reaper for `.claude/tmp/` (mantahostels#2214).
 *
 * The CLI tail is run as a real subprocess against a fixture directory:
 * nothing here points at the repo's own `.claude/tmp/`.
 *
 * Every fixture is aged against a FIXED clock (`NOW`), never wall time, so no
 * assertion here can pass or fail on how long the run took — EXCEPT the
 * CLI-tail block and the #1003 block below, whose fixtures are aged against
 * `Date.now()`: the CLI reads the real clock, and ctime cannot be backdated.
 *
 * Every fixture is backdated with `utimesSync`, which sets mtime only, and the
 * sweep ages by the later of mtime and ctime (#1003) — so the suite reads
 * mtime alone, through `readMtime`, and the real reader is driven by
 * `the write time userland cannot rewind` below.
 *
 * `sweep-debts-detached.sh` launches the sweep at every session start, and it
 * deletes for real: loosen a case and it can delete a live session's scratch
 * or a dispatched agent's artefact mid-run, or stop clearing `.claude/tmp/`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { earliestStart, sweepScratch, writtenAtMs } = require("./scratch-sweep");

/** A clock every fixture is aged against, so no test depends on wall time. */
const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
/** The ruled floors (mantahostels#2090), spelled here rather than imported. */
const SCRATCH_FLOOR = 24 * HOUR;
const RESEARCH_FLOOR = 7 * 24 * HOUR;

const roots: string[] = [];

function freshDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-sweep-"));
	roots.push(dir);
	return dir;
}

/** Writes `rel` under `dir` with an mtime `ageMs` before NOW. */
function aged(dir: string, rel: string, ageMs: number): string {
	const full = path.join(dir, rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, "x");
	const t = (NOW - ageMs) / 1000;
	fs.utimesSync(full, t, t);
	return full;
}

/** Back-dates a directory itself, which writing into it has just bumped. */
function ageDir(dir: string, rel: string, ageMs: number): void {
	const t = (NOW - ageMs) / 1000;
	fs.utimesSync(path.join(dir, rel), t, t);
}

/** An entry's mtime alone. */
function readMtime(full: string): number | null {
	try {
		return fs.lstatSync(full).mtimeMs;
	} catch {
		return null;
	}
}

/** A liveness oracle answering with sessions started `ageMs` before NOW. */
const started = (...ageMs: number[]) => ({
	agents: ageMs.map((a, i) => ({ sessionId: `s${i}`, startedAt: NOW - a })),
});

/** The oracle answering with nothing usable. */
const refused = { why: "`claude agents --json` would not run (ENOENT)" };

const discardFault = () => {
	/* the fault log is not what these cases read */
};

type Logged = [string, Error];

function run(
	dir: string,
	readAgents: () => unknown,
	logged: Logged[] = [],
): ReturnType<typeof sweepScratch> {
	return sweepScratch({
		dir,
		now: NOW,
		readAgents,
		logError: (where: string, err: Error) => logged.push([where, err]),
		timeOf: readMtime,
	});
}

afterEach(() => {
	for (const r of roots.splice(0))
		fs.rmSync(r, { recursive: true, force: true });
});

describe("the age limb", () => {
	it("deletes a file older than 24 hours", () => {
		const dir = freshDir();
		const f = aged(dir, "stale.out", 25 * HOUR);
		// Every live session started AFTER the file, so limb 2 condemns it too.
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([f]);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("keeps a file younger than 24 hours", () => {
		const dir = freshDir();
		// Paired with an aged file, or the sweep would never read the oracle and
		// the survival would prove only that the cheap pre-check short-circuited.
		aged(dir, "stale.out", 25 * HOUR);
		const young = aged(dir, "fresh.out", 23 * HOUR);
		expect(run(dir, () => started(1 * HOUR)).deleted).not.toContain(young);
		expect(fs.existsSync(young)).toBe(true);
	});
});

describe("the boundary itself", () => {
	it("spares a file at exactly 24 hours and takes one a millisecond past", () => {
		const dir = freshDir();
		const on = aged(dir, "on-the-line.out", SCRATCH_FLOOR);
		const over = aged(dir, "over.out", SCRATCH_FLOOR + 1);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([over]);
		expect(fs.existsSync(on)).toBe(true);
	});

	it("spares a research file at exactly 7 days and takes one a millisecond past", () => {
		const dir = freshDir();
		const on = aged(dir, "research-on-the-line.md", RESEARCH_FLOOR);
		const over = aged(dir, "research-over.md", RESEARCH_FLOOR + 1);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([over]);
		expect(fs.existsSync(on)).toBe(true);
	});
});

describe("the recursion limb — mantahostels#2018's hazard file sits in a subdirectory", () => {
	it("deletes the must-clear case, `i1995/guard.before.test.ts`", () => {
		const dir = freshDir();
		const f = aged(dir, "i1995/guard.before.test.ts", 30 * HOUR);
		ageDir(dir, "i1995", 30 * HOUR);
		const out = run(dir, () => started(1 * HOUR));
		expect(out.deleted).toContain(f);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("removes the directory the walk emptied, and keeps one still holding a survivor", () => {
		const dir = freshDir();
		aged(dir, "empty-me/old.txt", 30 * HOUR);
		ageDir(dir, "empty-me", 30 * HOUR);
		aged(dir, "keep-me/old.txt", 30 * HOUR);
		aged(dir, "keep-me/new.txt", 1 * HOUR);
		ageDir(dir, "keep-me", 30 * HOUR);

		run(dir, () => started(1 * HOUR));
		expect(fs.existsSync(path.join(dir, "empty-me"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "keep-me"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "keep-me/new.txt"))).toBe(true);
	});

	it("sees an aged candidate that only a subdirectory holds", () => {
		const dir = freshDir();
		aged(dir, "nested/deep/old.txt", 30 * HOUR);
		expect(run(dir, () => started(40 * HOUR)).readOracle).toBe(true);
	});
});

describe("the liveness limb", () => {
	it("keeps an aged file while a live session's startedAt predates its mtime", () => {
		const dir = freshDir();
		const f = aged(dir, "held.out", 30 * HOUR);
		// The session started 40 h ago, so it could have written the file 30 h ago.
		expect(run(dir, () => started(40 * HOUR)).deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("spares on the EARLIEST session, not on all of them", () => {
		const dir = freshDir();
		const f = aged(dir, "held.out", 30 * HOUR);
		// Two of the three started after the file; the third is what saves it.
		expect(
			run(dir, () => started(1 * HOUR, 40 * HOUR, 2 * HOUR)).deleted,
		).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("deletes where every live session started after the mtime", () => {
		const dir = freshDir();
		const f = aged(dir, "orphan.out", 30 * HOUR);
		expect(run(dir, () => started(29 * HOUR, 2 * HOUR)).deleted).toEqual([f]);
	});
});

describe("research artefacts keep their own 7-day floor", () => {
	it("keeps a `research-*` file older than 24 hours", () => {
		const dir = freshDir();
		const f = aged(dir, "research-suite-run-demand.md", 48 * HOUR);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("deletes a `research-*` file older than 7 days", () => {
		const dir = freshDir();
		const f = aged(dir, "research-old.md", RESEARCH_FLOOR + HOUR);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([f]);
	});

	it("does not pay the oracle for a research file inside its floor", () => {
		const dir = freshDir();
		aged(dir, "research-recent.md", 48 * HOUR);
		expect(run(dir, () => started(1 * HOUR)).readOracle).toBe(false);
	});
});

describe("a dispatched agent's evidence keeps the 7-day floor (#1009)", () => {
	it("keeps a file with `research` mid-name at 48 hours, and deletes it past 7 days", () => {
		const young = freshDir();
		const f = aged(young, "hw-routes-research.md", 48 * HOUR);
		aged(young, "stale.out", 25 * HOUR);
		expect(run(young, () => started(1 * HOUR)).deleted).not.toContain(f);
		expect(fs.existsSync(f)).toBe(true);

		const old = freshDir();
		const g = aged(old, "hw-routes-research.md", RESEARCH_FLOOR + HOUR);
		expect(run(old, () => started(1 * HOUR)).deleted).toEqual([g]);
	});

	it("keeps a guard-supplied `agents/` artefact at 48 hours, and clears it and its directory past 7 days", () => {
		const young = freshDir();
		const f = aged(young, "agents/x-1234abcd.md", 48 * HOUR);
		ageDir(young, "agents", 48 * HOUR);
		aged(young, "stale.out", 25 * HOUR);
		expect(run(young, () => started(1 * HOUR)).deleted).not.toContain(f);
		expect(fs.existsSync(f)).toBe(true);

		const old = freshDir();
		const g = aged(old, "agents/x-1234abcd.md", RESEARCH_FLOOR + HOUR);
		ageDir(old, "agents", RESEARCH_FLOOR + HOUR);
		const out = run(old, () => started(1 * HOUR));
		expect(out.deleted).toEqual([g, path.join(old, "agents")]);
	});

	it("keeps a nested `agents/` file, but not one under a non-top-level `agents/`", () => {
		const dir = freshDir();
		const kept = aged(dir, "agents/sub/x.md", 48 * HOUR);
		ageDir(dir, "agents/sub", 48 * HOUR);
		ageDir(dir, "agents", 48 * HOUR);
		const gone = aged(dir, "i1995/agents/y.md", 48 * HOUR);
		const out = run(dir, () => started(1 * HOUR));
		expect(fs.existsSync(kept)).toBe(true);
		expect(out.deleted).toContain(gone);
	});

	it("still deletes ordinary review and concision scratch at 48 hours", () => {
		const dir = freshDir();
		const review = aged(dir, "review-spec-abc.md", 48 * HOUR);
		const concision = aged(dir, "concision-x.md", 48 * HOUR);
		const out = run(dir, () => started(1 * HOUR));
		expect(out.deleted).toEqual(expect.arrayContaining([review, concision]));
	});

	it("does not pay the oracle for 48-hour-old `agents/` or `*research*` files", () => {
		const dir = freshDir();
		aged(dir, "agents/x-1234abcd.md", 48 * HOUR);
		ageDir(dir, "agents", 48 * HOUR);
		aged(dir, "hw-routes-research.md", 48 * HOUR);
		let read = false;
		const out = run(dir, () => {
			read = true;
			return started(1 * HOUR);
		});
		expect(out.readOracle).toBe(false);
		expect(read).toBe(false);
	});
});

/*
 * F8 (mantahostels#3515, #2): `markers/` is exempt; scratch-sweep.js says why.
 */
describe("the marker directory is exempt (F8, mantahostels#3515)", () => {
	it("never deletes a file under markers/, however old, with no live session", () => {
		const dir = freshDir();
		const f = aged(
			dir,
			"markers/.hook-ran-guard-fake-longgone",
			30 * 24 * HOUR,
		);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("never recurses into markers/ at all — a nested aged file survives too", () => {
		const dir = freshDir();
		const f = aged(
			dir,
			"markers/.hook-breadcrumbs/.hook-ran-guard-fake-longgone",
			30 * 24 * HOUR,
		);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("the identical fixture, placed outside markers/, is swept — proving the exemption above is not vacuous", () => {
		const dir = freshDir();
		const f = aged(dir, ".hook-ran-guard-fake-longgone", 30 * 24 * HOUR);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([f]);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("still sweeps an ordinary scratch file sitting beside markers/", () => {
		const dir = freshDir();
		aged(dir, "markers/.hook-ran-guard-fake-longgone", 30 * 24 * HOUR);
		const f = aged(dir, "throwaway.out", 25 * HOUR);
		expect(run(dir, () => started(1 * HOUR)).deleted).toEqual([f]);
		expect(fs.existsSync(f)).toBe(false);
	});
});

describe("an unreadable oracle", () => {
	it("deletes nothing and logs", () => {
		const dir = freshDir();
		const f = aged(dir, "stale.out", 30 * HOUR);
		const logged: Logged[] = [];
		const out = run(dir, () => refused, logged);
		expect(out.deleted).toEqual([]);
		expect(out.why).toBe(refused.why);
		expect(fs.existsSync(f)).toBe(true);
		expect(logged).toHaveLength(1);
		expect(logged[0][0]).toBe("sweepScratch");
		expect(logged[0][1].message).toBe(refused.why);
	});

	it("counts a record with no readable startedAt as doubt, sparing everything", () => {
		const dir = freshDir();
		const f = aged(dir, "stale.out", 30 * HOUR);
		// The oracle answered, so this is not the refusal above: the list is
		// usable and one record's start time is not.
		const out = run(dir, () => ({
			agents: [{ sessionId: "a", startedAt: NOW - HOUR }, { sessionId: "b" }],
		}));
		expect(out.deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("turns an oracle that THROWS into the same refusal, not into a crash, logging the thrown message", () => {
		const dir = freshDir();
		const f = aged(dir, "stale.out", 30 * HOUR);
		const logged: Logged[] = [];
		const out = run(
			dir,
			() => {
				throw new Error("the daemon went away");
			},
			logged,
		);
		expect(out.deleted).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
		expect(logged[0][1].message).toContain("the daemon went away");
	});

	it("logs and sweeps nothing when no oracle was passed at all", () => {
		const dir = freshDir();
		aged(dir, "stale.out", 30 * HOUR);
		const logged: Logged[] = [];
		const out = sweepScratch({
			dir,
			now: NOW,
			logError: (where: string, err: Error) => logged.push([where, err]),
			timeOf: readMtime,
		});
		expect(out.deleted).toEqual([]);
		expect(logged[0][1].message).toBe("no liveness oracle was passed");
	});
});

describe("the oracle read is not paid without a candidate", () => {
	it("skips the oracle when nothing is aged", () => {
		const dir = freshDir();
		aged(dir, "fresh.out", 2 * HOUR);
		let calls = 0;
		const out = run(dir, () => {
			calls += 1;
			return started(1 * HOUR);
		});
		expect(calls).toBe(0);
		expect(out.readOracle).toBe(false);
	});

	it("reads it once when one exists", () => {
		const dir = freshDir();
		aged(dir, "stale.out", 30 * HOUR);
		let calls = 0;
		const out = run(dir, () => {
			calls += 1;
			return started(1 * HOUR);
		});
		expect(calls).toBe(1);
		expect(out.readOracle).toBe(true);
	});

	it("skips the oracle for a missing directory", () => {
		let calls = 0;
		const out = run(path.join(freshDir(), "never-made"), () => {
			calls += 1;
			return started(1 * HOUR);
		});
		expect(calls).toBe(0);
		expect(out.deleted).toEqual([]);
	});
});

describe("what the walk cannot do, it records", () => {
	it("clears an aged empty directory, which no file inside can trigger", () => {
		const dir = freshDir();
		fs.mkdirSync(path.join(dir, "emptied"));
		ageDir(dir, "emptied", 30 * HOUR);
		// The pre-check has to see it: with no aged FILE anywhere, a files-only
		// walk pays no oracle read and the directory sits there for good.
		expect(run(dir, () => started(1 * HOUR)).readOracle).toBe(true);
		expect(fs.existsSync(path.join(dir, "emptied"))).toBe(false);
	});

	it("deletes an aged symlink rather than letting it immortalise its directory", () => {
		const dir = freshDir();
		fs.mkdirSync(path.join(dir, "linked"));
		// The target is OUTSIDE the fixture, so a walk that followed the link
		// would read a mtime that is none of the sweep's business — and one that
		// refused to unlink it would leave `linked` permanently ENOTEMPTY.
		const outside = path.join(dir, "..", "scratch-sweep-target");
		fs.writeFileSync(outside, "not ours");
		fs.symlinkSync(outside, path.join(dir, "linked", "link"));
		const t = (NOW - 30 * HOUR) / 1000;
		fs.lutimesSync(path.join(dir, "linked", "link"), t, t);
		ageDir(dir, "linked", 30 * HOUR);

		run(dir, () => started(1 * HOUR));
		expect(fs.existsSync(path.join(dir, "linked"))).toBe(false);
		expect(fs.existsSync(outside)).toBe(true);
		fs.rmSync(outside, { force: true });
	});

	it("logs a directory it cannot read, rather than retrying it in silence every session", () => {
		const dir = freshDir();
		aged(dir, "walled/old.txt", 30 * HOUR);
		ageDir(dir, "walled", 30 * HOUR);
		aged(dir, "reachable.out", 30 * HOUR);
		fs.chmodSync(path.join(dir, "walled"), 0o000);

		const logged: Logged[] = [];
		const out = run(dir, () => started(1 * HOUR), logged);
		fs.chmodSync(path.join(dir, "walled"), 0o755); // or the cleanup cannot either
		// The reachable file still went: one unreadable corner must not abort the
		// rest of the sweep.
		expect(out.deleted).toContain(path.join(dir, "reachable.out"));
		expect(out.failed.join(" ")).toContain("walled");
		expect(logged).toHaveLength(1);
		expect(logged[0][1].message).toMatch(/could not sweep 1/);
	});

	it("records nothing where the whole directory is simply absent", () => {
		const out = run(path.join(freshDir(), "never-made"), () =>
			started(1 * HOUR),
		);
		expect(out.failed).toEqual([]);
	});
});

describe("the CLI tail, which is what the session-start launcher runs", () => {
	/** Runs the module as the launcher does, against a fixture directory. */
	const cli = (scratch: string, extraEnv: Record<string, string> = {}) =>
		execFileSync(process.execPath, [path.join(__dirname, "scratch-sweep.js")], {
			encoding: "utf8",
			env: { ...process.env, WFC_SCRATCH_DIR: scratch, ...extraEnv },
		});

	/**
	 * Stands a fake `claude` on WFC_CLAUDE_BIN — no CI runner has a real one
	 * (mantahostels#2310), and this is the only test in this block with an aged candidate,
	 * so it is the only one that ever reaches the oracle (the aged-candidate
	 * pre-check gates it; a case gaining an aged file needs its own stub, silently, or it
	 * re-breaks CI the same way). Written OUTSIDE `dir`, the directory under
	 * test — inside it, the stub would be a fresh file the sweep itself has to
	 * spare, proving nothing about the sweep and everything about the stub's
	 * own mtime.
	 */
	function fakeClaudeBin(startedAtMs: number): string {
		const bin = path.join(freshDir(), "claude");
		const body = JSON.stringify([{ sessionId: "s0", startedAt: startedAtMs }]);
		fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit 0\n`);
		fs.chmodSync(bin, 0o755);
		return bin;
	}

	it("sweeps the directory WFC_SCRATCH_DIR names, and nothing else", () => {
		const dir = freshDir();
		// Both fixtures are aged against WALL time, not NOW: the CLI has its own
		// clock.
		const old = path.join(dir, "i1995", "guard.before.test.ts");
		fs.mkdirSync(path.dirname(old), { recursive: true });
		fs.writeFileSync(old, "x");
		const t = (Date.now() - 30 * HOUR) / 1000;
		fs.utimesSync(old, t, t);
		fs.utimesSync(path.dirname(old), t, t);
		const young = path.join(dir, "fresh.out");
		fs.writeFileSync(young, "x");
		const t2 = Date.now() / 1000;
		fs.utimesSync(young, t2, t2);
		// A live session started after `old`, so limb 2 condemns it too.
		const bin = fakeClaudeBin(Date.now());

		cli(dir, { WFC_CLAUDE_BIN: bin, WFC_SCRATCH_AGE_MTIME_ONLY: "1" });
		expect(fs.existsSync(old)).toBe(false);
		expect(fs.existsSync(young)).toBe(true);
	});

	it("says nothing and exits 0, a session start waiting on none of it", () => {
		expect(cli(freshDir())).toBe("");
	});

	it("exits 0 on a directory that does not exist", () => {
		const r = execFileSync(
			process.execPath,
			[path.join(__dirname, "scratch-sweep.js")],
			{
				encoding: "utf8",
				env: {
					...process.env,
					WFC_SCRATCH_DIR: path.join(freshDir(), "never-made"),
				},
			},
		);
		expect(r).toBe("");
	});
});

/*
 * These cases use the REAL reader and the real clock.
 */
describe("the write time userland cannot rewind (#1003)", () => {
	const day = 24 * HOUR;

	it("spares a fixture extracted by tar from an old commit, every session having started after that commit", () => {
		const repo = freshDir();
		const git = (...args: string[]) =>
			execFileSync("git", args, {
				cwd: repo,
				encoding: "buffer",
				env: {
					...process.env,
					GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
					GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
				},
			});
		git("init", "-q");
		fs.mkdirSync(path.join(repo, "r2"));
		fs.writeFileSync(path.join(repo, "r2", "page.html"), "<p>r2</p>");
		git("add", "r2");
		git(
			"-c",
			"user.name=T",
			"-c",
			"user.email=t@example.com",
			"commit",
			"-qm",
			"r2",
		);
		const archive = path.join(repo, "r2.tar");
		fs.writeFileSync(archive, git("archive", "HEAD", "r2"));

		const dir = freshDir();
		execFileSync("tar", ["-x", "-f", archive, "-C", dir]);
		const page = path.join(dir, "r2", "page.html");
		const commitMs = Date.parse("2020-01-01T00:00:00Z");
		// Not vacuous: tar really did backdate the mtime past both limbs.
		expect(fs.lstatSync(page).mtimeMs).toBe(commitMs);

		// An aged sibling forces the oracle read, so limb 2 is judged too.
		const other = path.join(dir, "other.out");
		fs.writeFileSync(other, "x");
		const now = Date.now();
		const out = sweepScratch({
			dir,
			now,
			readAgents: () => ({
				agents: [{ sessionId: "s0", startedAt: commitMs + day }],
			}),
			logError: discardFault,
			timeOf: (full: string) => (full === other ? commitMs : writtenAtMs(full)),
		});
		expect(out.readOracle).toBe(true);
		expect(out.deleted).toEqual([other]);
		expect(fs.existsSync(page)).toBe(true);
	});

	it("spares an old-mtime, new-ctime entry in the pre-check and in the walk", () => {
		const dir = freshDir();
		const now = Date.now();
		const backdated = path.join(dir, "backdated.out");
		fs.writeFileSync(backdated, "x");
		const t = (now - 30 * HOUR) / 1000;
		fs.utimesSync(backdated, t, t);
		// The pre-check alone: nothing else is aged, so the oracle goes unread.
		let calls = 0;
		const quiet = sweepScratch({
			dir,
			now,
			readAgents: () => {
				calls += 1;
				return started(1 * HOUR);
			},
			logError: discardFault,
		});
		expect(quiet.readOracle).toBe(false);
		expect(calls).toBe(0);

		// The walk: a second entry the reader calls aged forces the oracle
		// read.
		const other = path.join(dir, "other.out");
		fs.writeFileSync(other, "x");
		const out = sweepScratch({
			dir,
			now,
			readAgents: () => ({
				agents: [{ sessionId: "s0", startedAt: now - 1 * HOUR }],
			}),
			logError: discardFault,
			timeOf: (full: string) =>
				full === other ? now - 30 * HOUR : writtenAtMs(full),
		});
		expect(out.readOracle).toBe(true);
		expect(out.deleted).toEqual([other]);
		expect(fs.existsSync(backdated)).toBe(true);
	});

	it("reads the later of mtime and ctime, and mtime alone under the suite's switch", () => {
		const dir = freshDir();
		const f = path.join(dir, "f.out");
		fs.writeFileSync(f, "x");
		const t = (Date.now() - 30 * HOUR) / 1000;
		fs.utimesSync(f, t, t);
		const st = fs.lstatSync(f);
		expect(writtenAtMs(f)).toBe(st.ctimeMs);
		const prior = process.env.WFC_SCRATCH_AGE_MTIME_ONLY;
		process.env.WFC_SCRATCH_AGE_MTIME_ONLY = "1";
		try {
			expect(writtenAtMs(f)).toBe(st.mtimeMs);
		} finally {
			if (prior === undefined) delete process.env.WFC_SCRATCH_AGE_MTIME_ONLY;
			else process.env.WFC_SCRATCH_AGE_MTIME_ONLY = prior;
		}
		expect(writtenAtMs(path.join(dir, "gone"))).toBeNull();
	});
});

describe("earliestStart", () => {
	it("is the minimum across the live records", () => {
		expect(earliestStart([{ startedAt: 5 }, { startedAt: 2 }])).toBe(2);
	});

	it("is -Infinity — spare everything — on an unreadable start time", () => {
		expect(earliestStart([{ startedAt: 5 }, { startedAt: "soon" }])).toBe(
			Number.NEGATIVE_INFINITY,
		);
	});

	it("is -Infinity on an empty list, never +Infinity, which condemns everything", () => {
		// `listedAgents` refuses a list naming no agent, so this cannot arrive
		// through the wiring — but a fold over nothing defaults the other way, and
		// that default deletes the directory.
		expect(earliestStart([])).toBe(Number.NEGATIVE_INFINITY);
	});
});
