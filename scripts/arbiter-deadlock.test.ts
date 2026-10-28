// @vitest-environment node
/*
 * The deadlock half of the arbiter: taking a set of subjects without ever
 * holding one while waiting for another (mantahostels#1406), and naming a cycle once one
 * exists (mantahostels#1195), and `release --park`, the way out of a wait
 * nothing else can end, refusing while bytes it cannot account for are in the
 * file (mantahostels#1405, mantahostels#2400).
 *
 * Spawned rather than called in-process: what these guarantees are worth is the
 * exit code a poll loop branches on and the stdout a person reads, and both are
 * process-level facts.
 *
 * Every session's guarded write reaches session-arbiter.js through the
 * `PreToolUse` core lib/file-claim.js, and its claim-all, wait and park are the
 * moves a blocked session is told to make: loosen a case and two sessions can
 * wait on each other unnamed until their ceilings, or a park can throw away a
 * neighbour's edit.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	arbiterCli,
	commitAll,
	freshSandbox,
	gitRepo,
	live,
	registerSession,
	store,
} from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process";

const sb = freshSandbox();

const { cli, readListing } = arbiterCli(sb);

const inRepo = (rel: string) => path.join(sb.repo, rel);

/** Every subject currently locked, by the path the lock names. */
const readHeldPaths = () =>
	(store.readLocks() ?? [])
		.filter((l: { unreadable?: boolean }) => !l.unreadable)
		.map((l: { path: string }) => l.path)
		.sort();

/** A lock on `subject` held by a live session that is not the one under test. */
const neighbourHolds = (sessionId: string, subject: string) => {
	const me = live(sb, sessionId);
	const { verdict } = store.acquire(subject, me);
	expect(verdict).toBe("claimed");
};

describe("claim-all: the whole set, or nothing (mantahostels#1406)", () => {
	it("takes every subject when all are free", () => {
		live(sb, "mine");
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(readHeldPaths()).toEqual(["docs/a.md", "docs/b.md"]);
	});

	it("holds NOTHING when any one subject is refused, saying how many it put back", () => {
		neighbourHolds("neighbour", "docs/b.md");
		live(sb, "mine");
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		// docs/a.md was taken by this call and put back. The neighbour's lock is
		// the only one left.
		expect(readHeldPaths()).toEqual(["docs/b.md"]);
		expect(r.stderr).toContain("the set was NOT taken");
		// The count is what the reader acts on, and it counts actual drops rather
		// than attempts: dropIfUnchanged also answers kept and contended.
		expect(r.stderr).toContain("1 of the 1 taken by this call was put back");
	});

	it("keeps a claim this session already held before the call", () => {
		live(sb, "mine");
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		neighbourHolds("neighbour", "docs/b.md");
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		// Dropping the reentrant one would silently free a region mid-edit.
		expect(readHeldPaths()).toContain("docs/a.md");
	});

	it("refuses a misspelt region before taking any lock at all, naming the region", () => {
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		live(sb, "mine");
		const r = cli(
			[
				"claim-all",
				inRepo("docs/a.md"),
				`${inRepo("docs/doc-map.md")}#not-a-region`,
			],
			{ CLAUDE_CODE_SESSION_ID: "mine" },
		);
		expect(r.status).toBe(2);
		expect(readHeldPaths()).toEqual([]);
		// The refusal has to name the offending region and the way out, or the
		// caller retries a spelling that can never work.
		expect(r.stderr).toContain("not-a-region");
	});

	it("takes the set in one global order whatever order the caller names it", () => {
		// The neighbour holds the alphabetically FIRST subject, and the caller names
		// it LAST. Sorted acquisition tries it first and so takes nothing at all
		// before being refused; an unsorted run would take docs/z.md and have to put
		// it back. The count in the refusal is the only visible trace of the order,
		// and one global order is what stops two callers of this command taking an
		// overlapping set in opposite sequences.
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		const r = cli(["claim-all", inRepo("docs/z.md"), inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("nothing had been taken yet");
		expect(readHeldPaths()).toEqual(["docs/a.md"]);
	});
});

describe("the waiter register (mantahostels#1195)", () => {
	it("records what a denied session was blocked on", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(1);
		const wants = store.readWants();
		expect(wants).toHaveLength(1);
		expect(wants[0]).toMatchObject({ sessionId: "mine", wants: "docs/a.md" });
	});

	it("drops the record the moment the session claims anything", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		expect(store.readWants()).toHaveLength(1);
		expect(
			cli(["claim", inRepo("docs/b.md")], { CLAUDE_CODE_SESSION_ID: "mine" })
				.status,
		).toBe(0);
		expect(store.readWants()).toEqual([]);
	});

	it("forgets a want whose session is gone", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		// Rewrite the record onto a pid/start pair that cannot be alive.
		const f = store.paths.want("mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readWants()).toEqual([]);
	});
});

describe("the cycle report under list (mantahostels#1195)", () => {
	/** Two sessions, each holding what the other is denied. */
	const buildCycle = () => {
		// Two DIFFERENT live pids. The testkit keys its registry file by pid, so
		// registering both sessions on this process would leave only the second —
		// and an unidentifiable session records no want, so there would be no
		// cycle to find.
		registerSession(sb, "sess-a", process.ppid);
		registerSession(sb, "sess-b", process.pid);
		const a = store.identify("sess-a");
		const b = store.identify("sess-b");
		expect(a.durable).toBe(true);
		expect(b.durable).toBe(true);
		expect(store.acquire("docs/a.md", a).verdict).toBe("claimed");
		expect(store.acquire("docs/b.md", b).verdict).toBe("claimed");
		expect(
			cli(["claim", inRepo("docs/b.md")], { CLAUDE_CODE_SESSION_ID: "sess-a" })
				.status,
		).toBe(1);
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "sess-b" })
				.status,
		).toBe(1);
	};

	it("names a two-session cycle as a deadlock, once", () => {
		buildCycle();
		const listing = readListing(["list"]);
		expect(listing).toContain("DEADLOCK  2 session(s)");
		// One report per ring, whichever member the walk entered it from.
		expect(listing.match(/DEADLOCK/g)).toHaveLength(1);
		expect(listing).toContain("sess-a");
		expect(listing).toContain("sess-b");
	});

	it("still names the cycle when a member was RESUMED onto a new pid (#259)", () => {
		// A resumed holder read as dead breaks the ring in the report while it is
		// still a ring on disk: the reader is told WAITING and waits on a holder
		// that is itself blocked.
		buildCycle();
		const f = store.paths.lock("docs/a.md");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(
			f,
			JSON.stringify({ ...rec, pid: 999_999, procStart: "1" }),
		);
		const listing = readListing(["list"]);
		expect(listing).toContain("DEADLOCK  2 session(s)");
	});

	it("tells the reader which act breaks it", () => {
		buildCycle();
		const listing = readListing(["list"]);
		expect(listing).toContain("holds a DIRTY file commits it");
		expect(listing).toContain("claim-all");
	});

	it("calls a waiter behind a busy holder WAITING, never a deadlock", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		const listing = readListing(["list"]);
		// The holder is not itself waiting, so this wait ends on its own.
		expect(listing).toContain("WAITING");
		expect(listing).not.toContain("DEADLOCK");
	});

	it("says nothing at all when nobody is waiting", () => {
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		const listing = readListing(["list"]);
		expect(listing).not.toContain("WAITING");
		expect(listing).not.toContain("DEADLOCK");
	});

	it("sees a cycle closed by the region umbrella, not just by equal paths", () => {
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		registerSession(sb, "sess-a", process.ppid);
		registerSession(sb, "sess-b", process.pid);
		const a = store.identify("sess-a");
		const b = store.identify("sess-b");
		// sess-a holds the WHOLE map; sess-b holds an unrelated file. sess-b is
		// refused on one region of the map, which only the umbrella rule connects
		// to sess-a's whole-file lock (mantahostels#970).
		expect(store.acquire("docs/doc-map.md", a).verdict).toBe("claimed");
		expect(store.acquire("docs/other.md", b).verdict).toBe("claimed");
		expect(
			cli(["claim", inRepo("docs/other.md")], {
				CLAUDE_CODE_SESSION_ID: "sess-a",
			}).status,
		).toBe(1);
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B999`], {
				CLAUDE_CODE_SESSION_ID: "sess-b",
			}).status,
		).toBe(1);
		expect(readListing(["list"])).toContain("DEADLOCK  2 session(s)");
	});

	it("reports the cycle without releasing anything", () => {
		buildCycle();
		readListing(["list"]);
		// Diagnosis only: a report that dropped a lock would be a force-release
		// nobody asked for.
		expect(readHeldPaths()).toEqual(["docs/a.md", "docs/b.md"]);
	});
});

describe("release --park: the way out of a wait nothing else can end (mantahostels#1405)", () => {
	/** A real git repo in the sandbox: park restores from HEAD, so git must answer. */
	const committedRepo = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/a.md"), "committed\n");
		git("add", "docs/a.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
		return git;
	};

	/** Claim `subject` for `sessionId`, and dirty the file behind it. */
	const holdDirty = (sessionId: string, subject: string, rel: string) => {
		live(sb, sessionId);
		expect(
			cli(["claim", inRepo(subject)], { CLAUDE_CODE_SESSION_ID: sessionId })
				.status,
		).toBe(0);
		fs.writeFileSync(inRepo(rel), "unfinished\n");
	};

	it("refuses a dirty file without the flag, exactly as before, and keeps the claim", () => {
		committedRepo();
		holdDirty("mine", "docs/a.md", "docs/a.md");
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("uncommitted change");
		expect(readHeldPaths()).toEqual(["docs/a.md"]);
	});

	it("sets the edit aside, restores HEAD and lets the release through", () => {
		committedRepo();
		holdDirty("mine", "docs/a.md", "docs/a.md");
		const r = cli(["release", "--park", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo("docs/a.md"), "utf8")).toBe("committed\n");
		expect(readHeldPaths()).toEqual([]);
		// The unfinished edit survives, outside the working tree, with the command
		// to get it back printed beside it.
		const parked = r.stdout.match(/Your version:\s+(\S+)/)?.[1] as string;
		expect(fs.readFileSync(parked, "utf8")).toBe("unfinished\n");
		expect(r.stdout).toContain("Get it back");
	});

	it("removes an untracked file rather than inventing a HEAD for it", () => {
		committedRepo();
		holdDirty("mine", "docs/new.md", "docs/new.md");
		const r = cli(["release", "--park", inRepo("docs/new.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(fs.existsSync(inRepo("docs/new.md"))).toBe(false);
		const parked = r.stdout.match(/Your version:\s+(\S+)/)?.[1] as string;
		expect(fs.readFileSync(parked, "utf8")).toBe("unfinished\n");
	});

	it("refuses when another live session has also written the file, and leaves the file and its claim as they were", () => {
		committedRepo();
		holdDirty("mine", "docs/a.md", "docs/a.md");
		// A second live writer on the same path. viaBash, because that is the real
		// case: a neighbour reaching a guarded file through `cp` or `sed -i` takes
		// no claim, so an observation is the only trace it leaves (mantahostels#419).
		const other = live(sb, "neighbour");
		expect(
			store.recordObservation("docs/a.md", other, { viaBash: true }),
		).not.toBeNull();
		const r = cli(["release", "--park", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("their uncommitted work");
		expect(fs.readFileSync(inRepo("docs/a.md"), "utf8")).toBe("unfinished\n");
		expect(readHeldPaths()).toContain("docs/a.md");
	});

	it("refuses to park a file this session does not hold, leaving the file as it was", () => {
		committedRepo();
		neighbourHolds("neighbour", "docs/a.md");
		fs.writeFileSync(inRepo("docs/a.md"), "theirs\n");
		live(sb, "mine");
		const r = cli(["release", "--park", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("holds no claim on it");
		expect(fs.readFileSync(inRepo("docs/a.md"), "utf8")).toBe("theirs\n");
	});

	it("parks the whole file when the subject named one region, and says so", () => {
		const git = committedRepo();
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		git("add", "docs/doc-map.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		holdDirty("mine", "docs/doc-map.md#B999", "docs/doc-map.md");
		const r = cli(["release", "--park", `${inRepo("docs/doc-map.md")}#B999`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("the WHOLE file was parked");
		expect(fs.readFileSync(inRepo("docs/doc-map.md"), "utf8")).toBe("# map\n");
	});
});

describe("release --park on a file with nothing to park", () => {
	it("releases it rather than rewriting bytes it already has", () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/a.md"), "committed\n");
		git("add", "docs/a.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		const r = cli(["release", "--park", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("Parked");
		expect(readHeldPaths()).toEqual([]);
	});
});

describe("the register is fed by the path that actually fires (mantahostels#1195)", () => {
	/** The PreToolUse hook route: lib/file-claim.js runs `check`, never `claim`. */
	const check = (sessionId: string, rel: string) =>
		cli(["check", inRepo(rel), sessionId], {
			CLAUDE_CODE_SESSION_ID: sessionId,
		});

	it("records the want when the Write/Edit hook is the thing refused", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		const r = check("mine", "docs/a.md");
		expect(r.stdout).toContain('"permissionDecision":"deny"');
		// A register fed only by `claim` would be empty here — and a hook denial is
		// what "Denied?" means to every session in this repo.
		expect(store.readWants()).toMatchObject([
			{ sessionId: "mine", wants: "docs/a.md" },
		]);
	});

	it("drops the want when the hook route takes a claim", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		check("mine", "docs/a.md");
		expect(store.readWants()).toHaveLength(1);
		check("mine", "docs/b.md");
		expect(store.readWants()).toEqual([]);
	});

	it("names --park in the refusal a blocked session actually meets", () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/a.md"), "committed\n");
		git("add", "docs/a.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		fs.writeFileSync(inRepo("docs/a.md"), "unfinished\n");
		const r = cli(["release", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		// "Commit or discard" are both things a session blocked BY the commit
		// cannot do, so the escape has to be named in the same breath.
		expect(r.stderr).toContain("--park");
	});
});

describe("claim-all keeps the notices claim gives (mantahostels#1195's review)", () => {
	it("passes on a debt notice for a subject it took", () => {
		live(sb, "mine");
		store.ownDebt("docs/a.md", 999, "an edit that was denied earlier");
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("999");
	});
});

describe("what the code review found", () => {
	const gitInit = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		return git;
	};

	it("refuses to park a file a live neighbour holds a region of, and leaves the file as it was", () => {
		const git = gitInit();
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		git("add", "docs/doc-map.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		// Two different live pids: the registry keys sessions by pid.
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		const neighbour = store.identify("neighbour");
		expect(store.acquire("docs/doc-map.md#B998", neighbour).verdict).toBe(
			"claimed",
		);
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\nunfinished\n");
		const r = cli(["release", "--park", `${inRepo("docs/doc-map.md")}#B999`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		// The park writes the WHOLE file, so a neighbour on a sibling region is
		// about to lose bytes this session never wrote — and a claimant mints no
		// observation, so the observation register alone would not have seen them.
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo("docs/doc-map.md"), "utf8")).toContain(
			"unfinished",
		);
	});

	it("keeps a parked file's mode across the restore", () => {
		const git = gitInit();
		fs.writeFileSync(inRepo("scripts-x.sh"), "#!/bin/sh\necho hi\n");
		fs.chmodSync(inRepo("scripts-x.sh"), 0o755);
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.renameSync(inRepo("scripts-x.sh"), inRepo("scripts/x.sh"));
		git("add", "scripts/x.sh");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "x");
		live(sb, "mine");
		cli(["claim", inRepo("scripts/x.sh")], { CLAUDE_CODE_SESSION_ID: "mine" });
		// A DELETION is the case that needs the mode: there is no file left to stat,
		// so the restore has to get 100755 from git or it recreates a script that
		// will not run.
		fs.unlinkSync(inRepo("scripts/x.sh"));
		expect(
			cli(["release", "--park", inRepo("scripts/x.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		expect(fs.readFileSync(inRepo("scripts/x.sh"), "utf8")).toContain(
			"echo hi",
		);
		expect(fs.statSync(inRepo("scripts/x.sh")).mode & 0o111).not.toBe(0);
	});

	it("says the waiter register is unreadable rather than printing silence", () => {
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		// A file where the directory should be: readdir fails with ENOTDIR, which
		// is a fault and not an empty register.
		fs.writeFileSync(store.paths.wantsDir(), "not a directory");
		const r = cli(["list"], {});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("could not be read");
		// The listing itself is unaffected: the report is a diagnosis on top of it.
		expect(r.stdout).toContain("docs/a.md");
	});

	it("keeps a resumed waiter's record instead of deleting it", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		const f = store.paths.want("mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		// A resumed session reads as dead to holderAlive — same id, fresh host.
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readWants()).toEqual([]);
		// Skipped, not unlinked: deleting on that reading would drop a live
		// waiter's record and cost a real ring one member.
		expect(fs.existsSync(f)).toBe(true);
	});
});

describe("park sees a tool-route neighbour that took no claim (mantahostels#2333)", () => {
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });

	/** Commit whatever `scripts/a.sh` holds right now, hooks off. */
	const commitScript = (msg: string) => {
		git("add", "scripts/a.sh");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", msg);
	};

	/** A committed `scripts/a.sh`, so park has a HEAD to restore from. */
	const gitRepoWithScript = () => {
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.writeFileSync(inRepo("scripts/a.sh"), "committed\n");
		commitScript("base");
	};

	/**
	 * The neighbour's write, in the shape that made it invisible: it lands through
	 * the tool route with NO claim of its own, and no Bash call has scanned since.
	 *
	 * `record` is called directly rather than through `check`, because `check`
	 * claims on the watched union and a claim is what this window does not have.
	 * The real windows that reach here are lib/file-claim.js's fail-opens — an
	 * arbiter timeout, a non-zero exit — acquire()'s `unknown` on an
	 * unreadable store, and a lock swept as stale under a live session.
	 *
	 * With no `name`, the neighbour is registered without a session title.
	 */
	const neighbourWritesFirst = (name?: string) => {
		registerSession(sb, "neighbour", process.ppid, { name });
		fs.writeFileSync(inRepo("scripts/a.sh"), "neighbour's work\n");
		expect(
			cli(["record", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "neighbour",
			}).status,
		).toBe(0);
	};

	/** This session claims the path and leaves an unfinished edit on it. */
	const mineDirties = () => {
		registerSession(sb, "mine", process.pid);
		expect(
			cli(["claim", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("scripts/a.sh"), "unfinished\n");
	};

	const park = () =>
		cli(["release", "--park", inRepo("scripts/a.sh")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("refuses rather than restoring HEAD over the neighbour's bytes, naming the neighbour and leaving the file and claim as they were", () => {
		gitRepoWithScript();
		neighbourWritesFirst();
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		// The verdict, not just the exit code: five other park verdicts exit 1 and
		// leave the file alone too, so a sandbox whose git broke would pass on the
		// code alone. `shared` is the one this exists to reach, and it names the
		// neighbour as the existing verdict does.
		expect(r.stderr).toContain("also written");
		expect(r.stderr).toContain("neighbour");
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe(
			"unfinished\n",
		);
		expect(readHeldPaths()).toContain("scripts/a.sh");
	});

	it("parks a file this session holds its OWN observation on", () => {
		// The own-session filter, which nothing else covers: a session that wrote
		// the path before claiming it carries an observation of its own, and reading
		// that back as a neighbour would refuse every such park.
		gitRepoWithScript();
		registerSession(sb, "mine", process.pid);
		fs.writeFileSync(inRepo("scripts/a.sh"), "mine, before the claim\n");
		expect(
			cli(["record", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		mineDirties();
		expect(park().status).toBe(0);
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe("committed\n");
	});

	it("parks past a neighbour whose write is what HEAD now holds (mantahostels#2352)", () => {
		// An observation is dropped only on a release its session never calls.
		gitRepoWithScript();
		neighbourWritesFirst();
		commitScript("the neighbour's work, committed");
		mineDirties();
		const r = park();
		expect(r.status).toBe(0);
		// Restored to HEAD, which is the neighbour's committed bytes and not the
		// "committed\n" the base commit held.
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe(
			"neighbour's work\n",
		);
		const parked = r.stdout.match(/Your version:\s+(\S+)/)?.[1] as string;
		expect(fs.readFileSync(parked, "utf8")).toBe("unfinished\n");
	});

	it("still refuses where the committed neighbour has written again, naming the neighbour, and leaves the file as it was", () => {
		// Matching HEAD is what clears a writer, so a pin that has moved past HEAD
		// must still block.
		gitRepoWithScript();
		neighbourWritesFirst();
		commitScript("the neighbour's work, committed");
		fs.writeFileSync(inRepo("scripts/a.sh"), "neighbour, still going\n");
		expect(
			cli(["record", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "neighbour",
			}).status,
		).toBe(0);
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(r.stderr).toContain("neighbour");
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe(
			"unfinished\n",
		);
	});

	it("still refuses a neighbour with no pin on a path HEAD never had, reporting it also written and leaving the file as it was", () => {
		// The truthiness guard on `committed`, which nothing else reaches: a record
		// predating the `blob` field carries null, and so does HEAD's answer for a
		// path it has never held. Comparing the two without that guard reads
		// null === null as "their work is committed".
		gitRepoWithScript();
		registerSession(sb, "neighbour", process.ppid);
		fs.writeFileSync(inRepo("scripts/b.sh"), "neighbour's untracked work\n");
		fs.mkdirSync(store.paths.observationsDir(), { recursive: true });
		fs.writeFileSync(
			store.paths.observation("scripts/b.sh", "neighbour"),
			JSON.stringify({
				path: "scripts/b.sh",
				sessionId: "neighbour",
				obsId: "legacy",
				// Explicitly null, which is newObservation's own default for a record
				// that never pinned anything — an absent key reads as undefined and
				// would miss the comparison this test exists to reach.
				blob: null,
				at: new Date().toISOString(),
			}),
		);
		registerSession(sb, "mine", process.pid);
		expect(
			cli(["claim", inRepo("scripts/b.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("scripts/b.sh"), "unfinished\n");
		const r = cli(["release", "--park", inRepo("scripts/b.sh")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo("scripts/b.sh"), "utf8")).toBe(
			"unfinished\n",
		);
	});

	it("still parks where there is genuinely no other writer", () => {
		gitRepoWithScript();
		mineDirties();
		const r = park();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe("committed\n");
		const parked = r.stdout.match(/Your version:\s+(\S+)/)?.[1] as string;
		expect(fs.readFileSync(parked, "utf8")).toBe("unfinished\n");
	});

	it("never tells a shared refusal to commit, the one act it cannot do (mantahostels#2362)", () => {
		gitRepoWithScript();
		neighbourWritesFirst();
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).not.toContain("Commit or revert the file yourself");
		expect(r.stderr).toContain("Only THEY can clear this");
		// The refusal still names the neighbour and the verdict it came from.
		expect(r.stderr).toContain("also written");
		expect(r.stderr).toContain("neighbour");
		// No `list` pointer: every blocker here is claimless, so it would show
		// nobody (mantahostels#2453).
		expect(r.stderr).toContain(
			'session-arbiter.js debt own scripts/a.sh <issue> "<gist>"',
		);
	});

	it("offers no request route against a neighbour who holds no claim (mantahostels#2362)", () => {
		// The mantahostels#2333 shape: the neighbour reached the file from a route that mints an
		// observation and takes no lock.
		gitRepoWithScript();
		neighbourWritesFirst();
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).not.toContain("session-arbiter.js request scripts/a.sh");
		expect(r.stderr).toContain("nobody the arbiter can ask");
		expect(r.stderr).toContain("Take another subject");
	});

	it("leaves a writers-unknown refusal its commit-or-revert trailer (mantahostels#2362)", () => {
		// writers-unknown, reached by making the observation store unreadable: a
		// FILE where the directory belongs, so readdirSync throws ENOTDIR. Unlike
		// `shared` this one really is this session's own to clear.
		gitRepoWithScript();
		mineDirties();
		fs.rmSync(store.paths.observationsDir(), {
			recursive: true,
			force: true,
		});
		fs.writeFileSync(store.paths.observationsDir(), "");
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not be read");
		expect(r.stderr).toContain("Commit or revert the file yourself");
		expect(r.stderr).not.toContain("Only THEY can clear this");
	});

	it("names a blocking neighbour by its registry title, as `list` does (mantahostels#2397)", () => {
		gitRepoWithScript();
		// The same neighbour, under the title `list` would print for it.
		neighbourWritesFirst("Implement 2383");
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(r.stderr).toContain("Implement 2383 (id neighbour)");
	});

	it("degrades to the raw id for a session the registry cannot name (mantahostels#2397)", () => {
		// neighbourWritesFirst registers no `name`, which is the unnamed case.
		gitRepoWithScript();
		neighbourWritesFirst();
		mineDirties();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written scripts/a.sh: neighbour.");
		expect(r.stderr).toContain("Only THEY can clear this");
		// Never a bare `(id …)` with nothing in front of it.
		expect(r.stderr).not.toContain("(id neighbour)");
	});
});

describe("a claim holder blocks a park until the file accounts for them (mantahostels#2400)", () => {
	const docMap = "docs/doc-map.md";

	const doc = (b196: string, b197: string) =>
		[
			"# doc map",
			"",
			"## Section B — figures",
			"",
			"### B196 · Mine",
			"",
			b196,
			"",
			"### B197 · The neighbour's",
			"",
			b197,
			"",
		].join("\n");

	const writeMap = (text: string) => fs.writeFileSync(inRepo(docMap), text);

	/** A committed two-region map, and a live neighbour holding B197. */
	const committedMap = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		writeMap(doc("B196 as committed.", "B197 as committed."));
		git("add", docMap);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		registerSession(sb, "neighbour", process.ppid);
		registerSession(sb, "mine", process.pid);
		expect(
			store.acquire(`${docMap}#B197`, store.identify("neighbour")).verdict,
		).toBe("claimed");
	};

	/** Refresh the neighbour's PIN against whatever B197 holds right now. */
	const neighbourPins = () =>
		expect(
			cli(["record", inRepo(docMap)], { CLAUDE_CODE_SESSION_ID: "neighbour" })
				.status,
		).toBe(0);

	/**
	 * This session takes B196, leaves an unfinished edit in it, and PINS. `b197` is
	 * carried through rather than defaulted, because writeMap rewrites the WHOLE
	 * file: passing the committed text would revert the neighbour's region here
	 * and quietly undo the fixture the caller just built.
	 */
	const mineDirtiesB196 = (b197: string) => {
		expect(
			cli(["claim", `${inRepo(docMap)}#B196`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		writeMap(doc("B196, half-rewritten.", b197));
		minePins();
	};

	/**
	 * The PostToolUse refresh that follows this session's own Bash-route write:
	 * the refresh-claims core is a `PostToolUse` hook on Bash, so the write
	 * and its re-pin are one tool call and park is a later one (mantahostels#2421). Without
	 * it the fixture models a write no hook ever saw, and mantahostels#2421's backstop reads
	 * this session's own edit as a neighbour's.
	 */
	const minePins = () =>
		expect(
			cli(["refresh", "mine"], { CLAUDE_CODE_SESSION_ID: "mine" }).status,
		).toBe(0);

	const park = () =>
		cli(["release", "--park", `${inRepo(docMap)}#B196`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("parks where every region but this session's own is what HEAD holds", () => {
		// Cleared on the FILE, never on the holder's own pin (mantahostels#2362): B197 and the
		// head region are both at HEAD, so the only bytes park is about to
		// overwrite are this session's own.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		const r = park();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
		const parked = r.stdout.match(/Your version:\s+(\S+)/)?.[1] as string;
		expect(fs.readFileSync(parked, "utf8")).toContain("half-rewritten");
	});

	it("refuses while the neighbour's own region is uncommitted, and leaves the file as it was", () => {
		committedMap();
		writeMap(doc("B196 as committed.", "B197, mid-edit."));
		neighbourPins();
		mineDirtiesB196("B197, mid-edit.");
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toContain("half-rewritten");
	});

	it("refuses on a pin that matches HEAD but not the working tree, reporting it also written and leaving the file as it was", () => {
		// The stale-pin case: pinned while committed, written to since through a
		// window that minted nothing. It refuses on the BYTES rather than on the
		// pin: B197 no longer matches HEAD.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197, written since the pin.");
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toContain(
			"written since the pin",
		);
	});

	it("refuses where the neighbour Bash-wrote THIS session's own region, saying it no longer matches the pin, and leaves the bytes of the neighbour in place (mantahostels#2421)", () => {
		// The loss path mantahostels#2400 accepted. B196 is excluded from
		// outsideOwnRegionsMatchHead by construction, and a claim holder mints no
		// observation, so neither of park's limbs sees these bytes.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(doc("B196, and the neighbour was here.", "B197 as committed."));
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("no longer carries the bytes your own pin");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toContain(
			"the neighbour was here",
		);
	});

	it("names the drifted region and blames nobody for it (mantahostels#2429)", () => {
		// The same state as above, read as a MESSAGE. The two causes are
		// indistinguishable from the bytes, and the commoner of them is this
		// session's own write through a window the post-Bash re-pin missed — so
		// the `shared` advice, which sends the session to ask a holder to release,
		// would send it to somebody who wrote nothing and cannot help.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(
			doc("B196, written through an unpinned window.", "B197 as committed."),
		);
		const r = park();
		expect(r.status).toBe(1);
		// The WHY text, not a bare "B196": the retry line echoes the park subject
		// verbatim, so `toContain("B196")` passes on an empty region list too.
		expect(r.stderr).toContain("but B196 no longer carries");
		expect(r.stderr).not.toContain("Only THEY can clear this");
		expect(r.stderr).not.toContain("Parking would take their uncommitted work");
		// The escape, spelled as the two calls it takes and as the assertion it
		// makes — a bare "re-pin" would be advice the session cannot act on.
		expect(r.stderr).toContain("session-arbiter.js refresh");
		expect(r.stderr).toContain("release --park");
		expect(r.stderr).toContain("ASSERTS");
		// And the OTHER cause, which is the `shared` case under another name: the
		// two moves a denial obliges must survive here (mantahostels#1406).
		expect(r.stderr).toContain("session-arbiter.js request docs/doc-map.md");
		expect(r.stderr).toContain("session-arbiter.js debt own docs/doc-map.md");
		// And not the sibling trailer either: this session cannot commit, which is
		// why it reached --park at all (mantahostels#1405).
		expect(r.stderr).not.toContain("Commit or revert the file yourself");
	});

	it("hands back writers-unknown where a region it holds cannot be hashed (mantahostels#2429)", () => {
		// readSubjectBlobAt is null for a region gone from the tree as well as for a
		// git that would not answer, and mantahostels#2421 read both as drift — which now
		// hands over a route PAST the refusal.
		const preamble = "The preamble.";
		const noB196 = (pre: string) =>
			[
				"# doc map",
				"",
				"## Section B — figures",
				"",
				pre,
				"",
				"### B197 · The neighbour's",
				"",
				"B197 as committed.",
				"",
			].join("\n");
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		writeMap(noB196(preamble));
		git("add", docMap);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		registerSession(sb, "neighbour", process.ppid);
		registerSession(sb, "mine", process.pid);
		expect(
			store.acquire(`${docMap}#B197`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		neighbourPins();
		// The claim comes after the write because `claim` refuses a region the
		// file does not have.
		writeMap(doc("B196, briefly.", "B197 as committed."));
		for (const sub of ["#B196", "#section-b-preamble"])
			expect(
				cli(["claim", `${inRepo(docMap)}${sub}`], {
					CLAUDE_CODE_SESSION_ID: "mine",
				}).status,
			).toBe(0);
		minePins();
		writeMap(noB196("The preamble, half-rewritten."));
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not be hashed");
		// And never the drift escape, which would ask the session to assert over
		// an answer nothing got.
		expect(r.stderr).not.toContain("ASSERTS");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toContain("half-rewritten");
	});

	it("parks once the session re-pins the drifted region itself (mantahostels#2429)", () => {
		// The escape the refusal names, taken.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(
			doc("B196, written through an unpinned window.", "B197 as committed."),
		);
		expect(park().status).toBe(1);
		// Spelled as the refusal spells it — no positional id, the session's own
		// coming off CLAUDE_CODE_SESSION_ID. minePins passes one, so on its own it
		// leaves the copyable form unverified.
		expect(cli(["refresh"], { CLAUDE_CODE_SESSION_ID: "mine" }).status).toBe(0);
		const r = park();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
	});

	it("still says shared where the neighbour's own region is uncommitted too (mantahostels#2429)", () => {
		// PRECEDENCE. Both faults at once: B197 uncommitted AND B196 off its pin.
		// outsideOwnRegionsMatchHead is false, so the drift is never even asked
		// about.
		committedMap();
		writeMap(doc("B196 as committed.", "B197, mid-edit."));
		neighbourPins();
		mineDirtiesB196("B197, mid-edit.");
		writeMap(
			doc("B196, written through an unpinned window.", "B197, mid-edit."),
		);
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(r.stderr).toContain("Only THEY can clear this");
		expect(r.stderr).not.toContain("no longer carries the bytes your own pin");
	});

	it("still says shared where a claimless neighbour was observed too (mantahostels#2429)", () => {
		// The OTHER precedence limb. Everything outside B196 is what HEAD holds, so
		// the drift is asked about and answered — but the observation register adds
		// a live session the lock limb never named, whose uncommitted bytes park
		// would destroy. `shared` is then the true refusal and the drift must not
		// displace it.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(
			doc("B196, written through an unpinned window.", "B197 as committed."),
		);
		// Through `refresh` and not `record`: an observation on a GUARDED path is
		// minted by the Bash route alone (arbiter-observations.js), and the first
		// refresh only lays the baseline the second one measures against.
		registerSession(sb, "ghost", process.pid);
		const ghostSees = () =>
			expect(
				cli(["refresh", "ghost"], { CLAUDE_CODE_SESSION_ID: "ghost" }).status,
			).toBe(0);
		ghostSees();
		writeMap(doc("B196, and so was the ghost.", "B197 as committed."));
		ghostSees();
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(r.stderr).not.toContain("no longer carries the bytes your own pin");
	});

	it("re-pins through the hook entry itself, not just the verb (mantahostels#2429)", () => {
		// The dispatcher entry the PostToolUse hook actually fires, whose
		// refresh-claims core runs the verb's work in process. Its cores fail
		// open and say nothing, so only the pin it leaves says it did the work.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(doc("B196, half-rewritten twice.", "B197 as committed."));
		expect(park().status).toBe(1);
		const hook = runInProcess(path.join(__dirname, "guard-dispatch.js"), [], {
			cwd: sb.repo,
			stdin: JSON.stringify({
				session_id: "mine",
				hook_event_name: "PostToolUse",
				tool_name: "Bash",
				tool_input: { command: "sed -i s/x/y/ docs/doc-map.md" },
			}),
			env: { ...process.env, CLAUDE_CONFIG_DIR: sb.home },
		});
		expect(hook.status).toBe(0);
		expect(park().status).toBe(0);
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
	});

	it("still parks after THIS session's own Bash-route write to its own region (mantahostels#2421)", () => {
		// The PostToolUse refresh re-pins B196 within the same Bash call as the
		// write, so park — a later call — reads a pin carrying this session's own
		// bytes. A SECOND write, to prove it is the refresh doing the work rather
		// than the claim's own opening pin.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		writeMap(doc("B196, half-rewritten twice.", "B197 as committed."));
		minePins();
		const r = park();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
	});

	it("still parks while holding a sibling region it never wrote (mantahostels#2421)", () => {
		// The state `acquire` actually leaves: a claim mints no blob, so this
		// second region has no pin at all. Reading that as unknown-and-refuse
		// would refuse an unrelated park outright — ownRegionsOffPin walks every
		// region this session holds, not just the parked subject — and would
		// refuse for ever on a machine where the minting hooks fail open.
		committedMap();
		neighbourPins();
		mineDirtiesB196("B197 as committed.");
		// AFTER minePins, so the fan-out cannot pin it on the way past.
		expect(
			cli(["claim", `${inRepo(docMap)}#section-b-preamble`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		const r = park();
		expect(r.status).toBe(0);
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
	});
});

describe("the request route a shared park refusal names actually fires (mantahostels#2362)", () => {
	/**
	 * The only shape that reaches `shared` off the LOCK register: park demands
	 * this session hold the path, and two sessions can hold one file at once only
	 * where the claims are regions of it.
	 */
	const twoRegionHolders = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		git("add", "docs/doc-map.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		expect(
			store.acquire("docs/doc-map.md#B998", store.identify("neighbour"))
				.verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\nunfinished\n");
	};

	it("names request where the neighbour DOES hold a claim", () => {
		twoRegionHolders();
		const r = cli(["release", "--park", `${inRepo("docs/doc-map.md")}#B999`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			'session-arbiter.js request docs/doc-map.md "<why you need it>"',
		);
		expect(r.stderr).toContain("session-arbiter.js requests");
		expect(r.stderr).not.toContain("nobody the arbiter can ask");
	});

	it("records the request the refusal told the session to make", () => {
		// cmdRequest short-circuited on the asker's OWN cover, which a session at
		// --park always has, so the prescribed command recorded nothing and exited
		// 0 saying "The write is yours to make".
		twoRegionHolders();
		const r = cli(
			["request", inRepo("docs/doc-map.md"), "parking is blocked"],
			{
				CLAUDE_CODE_SESSION_ID: "mine",
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("The write is yours to make");
		expect(r.stdout).toContain("Requested docs/doc-map.md");
		expect(
			(store.readRequests() ?? []).map((q: { subject: string }) => q.subject),
		).toContain("docs/doc-map.md");
	});

	it("still says the write is yours where nobody else holds the file", () => {
		// The case cmdRequest was built for, and the one the reorder must not lose.
		registerSession(sb, "mine", process.pid);
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		const r = cli(["request", inRepo("docs/doc-map.md"), "why"], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.stdout).toContain("The write is yours to make");
		expect(store.readRequests()).toEqual([]);
	});
});

describe("the bytes no claim covers at all decide a park too (mantahostels#2400)", () => {
	/** A doc-map-shaped document: three `### B<n>` entries, one region each. */
	const map = (b1: string, b2: string, b3: string) =>
		`# Doc map\n\n## Section B — figures\n\n### B1 — one\n\n${b1}\n\n### B2 — two\n\n${b2}\n\n### B3 — three\n\n${b3}\n`;

	/** HEAD holds `map("alpha", "beta", "gamma")`, and `neighbour` claims B2. */
	const committedMapHeldByNeighbour = () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo("docs/doc-map.md"), map("alpha", "beta", "gamma"));
		git("add", "docs/doc-map.md");
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		// Two live pids: the registry keys sessions by pid.
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		// The claim pins B2 as HEAD holds it: the neighbour's own region is
		// committed.
		expect(
			store.acquire("docs/doc-map.md#B2", store.identify("neighbour")).verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B1`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
	};

	const park = () =>
		cli(["release", "--park", `${inRepo("docs/doc-map.md")}#B1`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("refuses where the holder's own region is committed but the file is not, reporting it also written and leaving the file as it was", () => {
		// B2 is committed, so the holder's pin equals HEAD and equals the tree.
		// Their uncommitted bytes are in B3, which no claim covers and park would
		// restore HEAD over.
		committedMapHeldByNeighbour();
		fs.writeFileSync(
			inRepo("docs/doc-map.md"),
			map("unfinished", "beta", "the neighbour's uncommitted work"),
		);
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo("docs/doc-map.md"), "utf8")).toContain(
			"the neighbour's uncommitted work",
		);
	});

	it("refuses where the working tree has grown a region HEAD never had, reporting it also written and leaving the file as it was", () => {
		// Appended past the last region, so no existing region's bytes move.
		committedMapHeldByNeighbour();
		fs.writeFileSync(
			inRepo("docs/doc-map.md"),
			`${map("unfinished", "beta", "gamma")}### B4 — four\n\ndelta\n`,
		);
		const r = park();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo("docs/doc-map.md"), "utf8")).toContain("B4");
	});
});

describe("the sidecar's gaps between keys belong to no region (mantahostels#2400)", () => {
	// docs/doc-map-classes.json is regioned by JSON KEY, and the commas and braces
	// between two keys belong to no region at all — so a key present on only one
	// side changes no other key's bytes.
	const sidecar = "docs/doc-map-classes.json";
	const json = (keys: Record<string, unknown>) =>
		`${JSON.stringify(keys, null, "\t")}\n`;

	it("refuses a park over a key the working tree has and HEAD has not, reporting it also written and leaving the file as it was", () => {
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo(sidecar), json({ a: { x: 1 }, b: { y: 2 } }));
		git("add", sidecar);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "sidecar");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		expect(
			store.acquire(`${sidecar}#A:b`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo(sidecar)}#A:a`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		// `a` is this session's own unfinished edit; `c` is a registration nobody
		// holds a claim on, and `b` — the only region HEAD and the tree share
		// outside our own — is untouched.
		fs.writeFileSync(
			inRepo(sidecar),
			json({ a: { x: 9 }, b: { y: 2 }, c: { z: 3 } }),
		);
		const r = cli(["release", "--park", `${inRepo(sidecar)}#A:a`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo(sidecar), "utf8")).toContain('"c"');
	});
});

describe("a park is refused by bytes that belong to no region at all (mantahostels#2400)", () => {
	// Two shapes that a per-region-id comparison calls settled and the file does
	// not, both of them a neighbour's uncommitted work park would overwrite.
	const git = (...a: string[]) =>
		execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });

	const commitAnd = (rel: string, text: string) => {
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo(rel), text);
		git("add", rel);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "base");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
	};

	it("refuses where two entries were SWAPPED and every region still matches, and leaves the file as it was", () => {
		const docMap = "docs/doc-map.md";
		const entry = (id: string, body: string) => `### ${id} · x\n\n${body}\n\n`;
		const head = "# doc map\n\n## Section B — figures\n\n";
		commitAnd(docMap, head + entry("B196", "mine.") + entry("B197", "theirs."));
		expect(
			store.acquire(`${docMap}#B197`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo(docMap)}#B196`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		// Every region id's bytes are exactly HEAD's; only their ORDER moved, and
		// order belongs to no region.
		fs.writeFileSync(
			inRepo(docMap),
			head + entry("B197", "theirs.") + entry("B196", "mine."),
		);
		const r = cli(["release", "--park", `${inRepo(docMap)}#B196`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			head + entry("B197", "theirs.") + entry("B196", "mine."),
		);
	});

	it("refuses over a sidecar key whose value is a scalar, which mints no region, and leaves the file as it was", () => {
		const sidecar = "docs/doc-map-classes.json";
		const json = (keys: Record<string, unknown>) =>
			`${JSON.stringify(keys, null, "\t")}\n`;
		commitAnd(sidecar, json({ a: { x: 1 }, b: { y: 2 } }));
		expect(
			store.acquire(`${sidecar}#A:b`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo(sidecar)}#A:a`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		// `parseJsonKeyRegions` mints a region for an OBJECT-valued key only, so
		// `schemaVersion` is bytes under no id whatever.
		fs.writeFileSync(
			inRepo(sidecar),
			json({ a: { x: 9 }, b: { y: 2 }, schemaVersion: 4 }),
		);
		const r = cli(["release", "--park", `${inRepo(sidecar)}#A:a`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("also written");
		expect(fs.readFileSync(inRepo(sidecar), "utf8")).toContain("schemaVersion");
	});
});

describe("a holder the lock limb cleared is still somebody to ask (mantahostels#2400)", () => {
	it("names request where the observation limb put a cleared holder back", () => {
		// The lock limb clears every holder once the
		// file is settled outside this session's own regions; the observation limb
		// then puts one back on a stale record their `acquire` never dropped. The
		// refusal reads `claimants` to decide whether there is anybody to ASK, so a
		// holder that reappears has to reappear there too.
		const docMap = "docs/doc-map.md";
		const doc = (b196: string, b197 = "committed.") =>
			`# doc map\n\n## Section B — figures\n\n### B196 · Mine\n\n${b196}\n\n### B197 · Theirs\n\n${b197}\n`;
		const git = (...a: string[]) =>
			execFileSync("git", a, { cwd: sb.repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "T");
		fs.writeFileSync(inRepo(docMap), doc("committed."));
		git("add", docMap);
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "map");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		expect(
			cli(["claim", `${inRepo(docMap)}#B196`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		// The neighbour writes from the BASH route and refreshes, which mints an
		// observation pinning that text: docs/doc-map.md is a refusing-tier path,
		// so the tool route mints nothing on it. The first refresh only lays the
		// scan baseline down — it reports nothing changed by construction.
		const refresh = () =>
			expect(
				cli(["refresh"], { CLAUDE_CODE_SESSION_ID: "neighbour" }).status,
			).toBe(0);
		refresh();
		fs.writeFileSync(inRepo(docMap), doc("committed.", "mid-edit."));
		refresh();
		// Back to what HEAD holds outside B196, so the lock limb clears them while
		// their record still points at the text above.
		fs.writeFileSync(inRepo(docMap), doc("half-rewritten."));
		expect(
			store.acquire(`${docMap}#B197`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		const r = cli(["release", "--park", `${inRepo(docMap)}#B196`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			'session-arbiter.js request docs/doc-map.md "<why you need it>"',
		);
		expect(r.stderr).not.toContain("nobody the arbiter can ask");
	});
});

describe("a writers-unknown refusal names which answer could not be got (mantahostels#2417)", () => {
	/** A committed `scripts/a.sh` this session claims and then dirties. */
	const mineDirtiesAScript = () => {
		gitRepo(sb);
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.writeFileSync(inRepo("scripts/a.sh"), "committed\n");
		commitAll(sb, "base");
		registerSession(sb, "mine", process.pid);
		expect(
			cli(["claim", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("scripts/a.sh"), "unfinished\n");
	};

	/** A FILE where a directory belongs, so readdirSync throws ENOTDIR. */
	const blindDir = (dir: string) => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.writeFileSync(dir, "");
	};

	const parkScript = () =>
		cli(["release", "--park", inRepo("scripts/a.sh")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("names the observation register when that is what went dark", () => {
		mineDirtiesAScript();
		blindDir(store.paths.observationsDir());
		const r = parkScript();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"the observation register could not be read, so nothing here can say",
		);
		expect(fs.readFileSync(inRepo("scripts/a.sh"), "utf8")).toBe(
			"unfinished\n",
		);
	});

	it("names the session registry rather than the observation register", () => {
		mineDirtiesAScript();
		blindDir(store.paths.sessionsDir());
		const r = parkScript();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the session registry could not be read");
		expect(r.stderr).not.toContain(
			"the observation register could not be read",
		);
	});

	/**
	 * The last two causes live inside outsideOwnRegionsMatchHead, which is reached
	 * only on a REGIONED path with a live claim holder on it — so both fixtures
	 * are a doc-map with a neighbour holding a sibling region.
	 */
	const neighbourHoldsARegion = () => {
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		expect(
			store.acquire("docs/doc-map.md#B998", store.identify("neighbour"))
				.verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo("docs/doc-map.md")}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
	};

	const parkMap = () =>
		cli(["release", "--park", `${inRepo("docs/doc-map.md")}#B999`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("names git when HEAD is what could not be read", () => {
		// A repo with a commit, and a doc-map that is not in it, so `git show HEAD:…`
		// fails.
		gitRepo(sb);
		fs.writeFileSync(inRepo("docs/other.md"), "x\n");
		commitAll(sb, "base");
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\nunfinished\n");
		neighbourHoldsARegion();
		const r = parkMap();
		expect(r.status).toBe(1);
		// The writers-unknown TAIL as well: `uncheckable` opens on this same
		// sentence, so the first line alone would keep passing on a regression that
		// landed there instead.
		expect(r.stderr).toContain(
			"git could not say what HEAD holds for docs/doc-map.md, so nothing here can say whether another session has also written",
		);
		expect(r.stderr).not.toContain(
			"the observation register could not be read",
		);
	});

	it("names the working tree when the file itself could not be read", () => {
		gitRepo(sb);
		fs.writeFileSync(inRepo("docs/doc-map.md"), "# map\n");
		commitAll(sb, "map");
		neighbourHoldsARegion();
		// Deleted from disk: dirty against HEAD, readable in HEAD, unreadable here.
		fs.rmSync(inRepo("docs/doc-map.md"));
		const r = parkMap();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"docs/doc-map.md could not be read from the working tree",
		);
		expect(r.stderr).not.toContain(
			"the observation register could not be read",
		);
	});

	it("never reaches the claim store as a cause, and says so plainly", () => {
		// The fifth cause exists in otherWritersOn and cannot fire from the CLI:
		// parkFirst reads the locks first, to check this session holds the file, and
		// an unreadable store there reads as holding nothing. So the session gets an
		// earlier refusal that never mentions the claim store at all.
		//
		// Blinding the directory destroys the lock file too, so the refusal below is equally consistent with
		// a claim that was simply never taken; and it reaches only claimHoldersOn's
		// limb, outsideOwnRegionsMatchHead's own `locks` needing a SECOND read to
		// fail after the first succeeded, which no fixture can arrange. It is a
		// tripwire: the day parkFirst propagates its own read, this is what fails.
		mineDirtiesAScript();
		blindDir(store.paths.locksDir());
		const r = parkScript();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("this session holds no claim on it");
		expect(r.stderr).not.toContain("the claim store could not be read");
	});
});

describe("a shared park refusal offers `list` only where it will show somebody (mantahostels#2453)", () => {
	const docMap = "docs/doc-map.md";
	const map = (b998: string, b999: string) =>
		`# Doc map\n\n## Section B\n\n### B998 — theirs\n\n${b998}\n\n### B999 — mine\n\n${b999}\n`;

	const parkMap = () =>
		cli(["release", "--park", `${inRepo(docMap)}#B999`], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});

	it("omits the pointer where every blocker wrote without a claim", () => {
		// The mantahostels#2333 shape, and the commonest one to reach `shared`: the neighbour
		// is in the observation register alone, so `list` would print nobody.
		gitRepo(sb);
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.writeFileSync(inRepo("scripts/a.sh"), "committed\n");
		commitAll(sb, "base");
		registerSession(sb, "neighbour", process.ppid);
		fs.writeFileSync(inRepo("scripts/a.sh"), "neighbour's work\n");
		expect(
			cli(["record", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "neighbour",
			}).status,
		).toBe(0);
		registerSession(sb, "mine", process.pid);
		expect(
			cli(["claim", inRepo("scripts/a.sh")], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(inRepo("scripts/a.sh"), "unfinished\n");
		const r = cli(["release", "--park", inRepo("scripts/a.sh")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("nobody the arbiter can ask");
		expect(r.stderr).not.toContain("session-arbiter.js list");
		// The debt line, which follows the pointer, must survive its removal.
		expect(r.stderr).toContain("session-arbiter.js debt own scripts/a.sh");
	});

	it("offers the pointer plainly where every blocker holds a claim", () => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(docMap), map("theirs", "mine"));
		commitAll(sb, "map");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		expect(
			store.acquire(`${docMap}#B998`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		expect(
			cli(["claim", `${inRepo(docMap)}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(
			inRepo(docMap),
			map("theirs, mid-edit", "mine, unfinished"),
		);
		const r = parkMap();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"Who holds it:  node scripts/session-arbiter.js list\n",
		);
		expect(r.stderr).not.toContain("blockers above that hold a claim");
	});

	it("says how many of a mixed set the pointer will show", () => {
		// The two blocker shapes can only meet on a REGIONED path — the lock limb
		// needs a second holder of the same file, which only regions allow — and
		// every regioned path is guarded, where recordObservation refuses the tool
		// route (arbiter-observations.js). The Bash route is what reaches it: the
		// ghost writes from a shell and the post-Bash scan mints for it (mantahostels#419).
		gitRepo(sb);
		fs.writeFileSync(inRepo(docMap), map("theirs", "mine"));
		commitAll(sb, "map");
		registerSession(sb, "mine", process.pid);
		registerSession(sb, "neighbour", process.ppid);
		// pid 1, not process.ppid: the registry file is named for the PID, so a third
		// session sharing the neighbour's would overwrite its entry and the
		// neighbour would read as not live at all.
		registerSession(sb, "ghost", 1);
		expect(
			store.acquire(`${docMap}#B998`, store.identify("neighbour")).verdict,
		).toBe("claimed");
		// The claimless one: a baseline scan, a shell write, then the scan that
		// mints the observation off it.
		const ghostRefresh = () =>
			expect(
				cli(["refresh", "ghost"], { CLAUDE_CODE_SESSION_ID: "ghost" }).status,
			).toBe(0);
		ghostRefresh();
		fs.writeFileSync(inRepo(docMap), map("theirs", "the ghost was here"));
		ghostRefresh();
		expect(
			cli(["claim", `${inRepo(docMap)}#B999`], {
				CLAUDE_CODE_SESSION_ID: "mine",
			}).status,
		).toBe(0);
		fs.writeFileSync(
			inRepo(docMap),
			map("theirs, mid-edit", "mine, unfinished"),
		);
		const r = parkMap();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"it lists the 1 of the 2 blockers above that hold a claim",
		);
		expect(r.stderr).toContain(`session-arbiter.js request ${docMap}`);
	});
});
