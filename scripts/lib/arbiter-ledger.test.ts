// @vitest-environment node
/*
 * arbiter-ledger.js's own suite: a ledger is swept only once its session is
 * provably finished, never on age alone, and the commit and selection ledgers
 * answer who made a commit, which paths its commits touched and who quoted a
 * path, and the acts ledger what else a session did (mantahostels#137, #1154,
 * #1220, #2308, #2390).
 *
 * Each case runs in arbiter-testkit's sandbox with sessions registered live or
 * finished by hand and ledgers backdated on disk, so a week's ageing is one
 * `utimes` call rather than a wait.
 *
 * The `Stop` guards that name a session's own uncommitted edits and unpushed
 * commits read these ledgers: loosen a case here and a running session's
 * ledger is swept and its work goes unattributed, or a neighbour's is pinned
 * on it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	commitAll,
	finished,
	freshSandbox,
	gitRepo,
	ledger,
	live,
	registerSession,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

/** What the post-write core records on PostToolUse. */
const record = (rel: string, sessionId: string) =>
	store.recordWrite(path.join(sb.repo, rel), sessionId);

/** Past LEDGER_AGE_MS (7 days). */
const backdate = (file: string) => {
	const when = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
	fs.utimesSync(file, when, when);
};

/*
 * mantahostels#137. mtime is a session's LAST write, not its first, and a resumed session
 * keeps its id across a quiet week — so an age-only sweep deleted the ledger of
 * a session that was still running, and `writes` then answered empty for it.
 */

describe("ledger sweep — age alone does not make a ledger dead", () => {
	const age = (sessionId: string) => backdate(store.paths.ledger(sessionId));

	const exists = (sessionId: string) =>
		fs.existsSync(store.paths.ledger(sessionId));

	/** A new session's first write, which is what runs the sweep. */
	let writers = 0;
	const sweep = () => record("docs/first.md", `first-writer-${writers++}`);

	it("spares a live session's ledger however old it is", () => {
		record("docs/mine.md", "alice");
		live(sb, "alice");
		age("alice");

		sweep();

		expect(exists("alice")).toBe(true);
		expect(store.readWritesBy("alice")).toEqual(["docs/mine.md"]);
	});

	it("still sweeps a finished session's aged ledger", () => {
		// The directory must stay bounded — sparing everything would trade one
		// leak for another.
		record("docs/theirs.md", "bob");
		finished(sb, "bob");
		age("bob");

		sweep();

		expect(exists("bob")).toBe(false);
	});

	it("still sweeps a ledger belonging to no known session at all", () => {
		record("docs/ghost.md", "never-registered");
		age("never-registered");

		sweep();

		expect(exists("never-registered")).toBe(false);
	});

	it("leaves a finished session's recent ledger alone", () => {
		record("docs/theirs.md", "bob");
		finished(sb, "bob");

		sweep();

		expect(exists("bob")).toBe(true);
	});

	it("reproduces the reported path: another session's first write sweeps nothing live", () => {
		// recordWrite fires the sweep whenever ANY session mints its first ledger.
		record("docs/mine.md", "alice");
		live(sb, "alice");
		age("alice");

		record("docs/new.md", "newcomer");

		expect(store.readWritesBy("alice")).toEqual(["docs/mine.md"]);
	});

	it("counts a session whose liveness cannot be proved as live", () => {
		// identify() treats a missing procStart as not-alive, because a lock minted
		// on it would wedge a file for good. The costs invert here: keeping a
		// finished session's ledger only wastes bytes.
		record("docs/mine.md", "alice");
		registerSession(sb, "alice", process.pid, { procStart: null });
		age("alice");

		sweep();

		expect(exists("alice")).toBe(true);
	});

	// Kept beside arbiter-sweep.test.ts's case for every other family (§X7,
	// #1372): recordWrite runs this sweep, never pruneAll, so that case misses it.
	it("deletes nothing when the registry itself cannot be read", () => {
		record("docs/mine.md", "alice");
		age("alice");
		fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
		try {
			sweep();
		} finally {
			fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
		}

		expect(exists("alice")).toBe(true);
	});

	it("logs the unreadable registry, so a sweep that stopped is visible", () => {
		// Otherwise the sweep disables itself for as long as the registry stays
		// unreadable, with nothing for check-guard-errors to show.
		record("docs/mine.md", "alice");
		fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
		try {
			sweep();
		} finally {
			fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
		}

		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("pruneLedgers");
	});

	it("sweeps normally on a machine with no sessions registry", () => {
		// Absent is not unreadable: nothing was ever registered, so nothing is live.
		record("docs/ghost.md", "alice");
		age("alice");
		fs.rmSync(path.join(sb.home, "sessions"), { recursive: true, force: true });

		sweep();

		expect(exists("alice")).toBe(false);
	});
});

describe("readOwnersOf — which session made each commit (#1154, #1213)", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);
	const C = "c".repeat(40);

	it("maps each commit some ledger names to that ledger's session, and leaves the rest out", () => {
		store.recordCommit(A, "alice");
		store.recordCommit(B, "bob");
		store.recordCommit(C, "bob");

		expect(ledger.readOwnersOf([A, B, "d".repeat(40)])).toEqual(
			new Map([
				[A, "alice"],
				[B, "bob"],
			]),
		);
	});

	it("answers an empty map where no commit was ever recorded", () => {
		fs.rmSync(store.paths.commitsDir(), { recursive: true, force: true });
		expect(ledger.readOwnersOf([A])).toEqual(new Map());
	});
});

describe("readBilledPathsBy — the paths a session wrote or its commits touched (#2390, #2971)", () => {
	const readHead = () =>
		execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
	const commitFile = (rel: string) => {
		fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(sb.repo, rel), `${rel}\n`);
		commitAll(sb, rel);
		return readHead();
	};

	it("answers each path its commits touched once, its root commit and a gone commit included", () => {
		gitRepo(sb);
		store.recordCommit(commitFile("scripts/a.js"), "alice");
		store.recordCommit("f".repeat(40), "alice");
		commitFile("scripts/theirs.js");
		fs.appendFileSync(path.join(sb.repo, "scripts/a.js"), "more\n");
		store.recordCommit(commitFile("docs/b.md"), "alice");

		expect(ledger.readBilledPathsBy("alice", "t")?.sort()).toEqual([
			"docs/b.md",
			"scripts/a.js",
		]);
		expect(ledger.readBilledPathsBy("bob", "t")).toEqual([]);
	});

	it("bills a merge only its own conflict resolutions, never the other side's paths", () => {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: sb.repo, stdio: "ignore" });
		const both = path.join(sb.repo, "docs/both.md");
		gitRepo(sb);
		commitFile("docs/both.md");
		git("checkout", "-qb", "theirs");
		fs.writeFileSync(both, "theirs\n");
		commitFile("scripts/theirs.js");
		git("checkout", "-q", "-");
		fs.writeFileSync(both, "mine\n");
		commitFile("scripts/a.js");
		try {
			git("merge", "-q", "theirs");
		} catch {
			// The conflict on docs/both.md, resolved and committed below.
		}
		fs.writeFileSync(both, "resolved\n");
		commitAll(sb, "merge");
		store.recordCommit(readHead(), "alice");

		expect(ledger.readBilledPathsBy("alice", "t")).toEqual(["docs/both.md"]);
	});

	it("adds the paths it wrote to its commits' once each", () => {
		gitRepo(sb);
		store.recordCommit(commitFile("scripts/a.js"), "alice");
		record("scripts/a.js", "alice");
		record("docs/new.md", "alice");
		expect(ledger.readBilledPathsBy("alice", "t")?.sort()).toEqual([
			"docs/new.md",
			"scripts/a.js",
		]);
	});

	it.skipIf(AS_ROOT)(
		"answers the writes alone, logged under the caller's label, where the commit ledger will not read",
		() => {
			gitRepo(sb);
			store.recordCommit(commitFile("scripts/a.js"), "alice");
			record("docs/new.md", "alice");
			const file = store.paths.commitLedger("alice", sb.repo);
			fs.chmodSync(file, 0o000);
			try {
				expect(ledger.readBilledPathsBy("alice", "the caller")).toEqual([
					"docs/new.md",
				]);
			} finally {
				fs.chmodSync(file, 0o644);
			}
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("the caller");
		},
	);

	it.skipIf(AS_ROOT)(
		"answers null, never [], where the write ledger will not read",
		() => {
			record("docs/new.md", "alice");
			const file = store.paths.ledger("alice");
			fs.chmodSync(file, 0o000);
			try {
				expect(ledger.readBilledPathsBy("alice", "t")).toBe(null);
			} finally {
				fs.chmodSync(file, 0o644);
			}
		},
	);
});

describe("readSelectsBy — the selection ledger's newest stamp per path (#1220)", () => {
	it("answers each path once, at its newest stamp", () => {
		ledger.recordSelect("scripts/a.js", "sel-newest", 200);
		ledger.recordSelect("scripts/a.js", "sel-newest", 100);
		ledger.recordSelect("scripts/b.js", "sel-newest", 50);
		expect(ledger.readSelectsBy("sel-newest")).toEqual([
			{ path: "scripts/a.js", at: 200 },
			{ path: "scripts/b.js", at: 50 },
		]);
	});

	it("reads an unstamped line as 0, older than any commit", () => {
		fs.mkdirSync(store.paths.selectsDir(), { recursive: true });
		fs.writeFileSync(store.paths.selectLedger("sel-bare"), "scripts/c.js\n");
		expect(ledger.readSelectsBy("sel-bare")).toEqual([
			{ path: "scripts/c.js", at: 0 },
		]);
	});

	it("answers [] for a session that quoted nothing, and null with no id", () => {
		expect(ledger.readSelectsBy("sel-none")).toEqual([]);
		expect(ledger.readSelectsBy("")).toBe(null);
	});
});

describe("readLandedBy — released with only others' dirt, and not written since (#2539)", () => {
	it("names a released path until the session writes it again", () => {
		ledger.recordLanded("scripts/a.js", "landed-last");
		ledger.recordLanded("scripts/b.js", "landed-last");
		expect(ledger.readLandedBy("landed-last")).toEqual(
			new Set(["scripts/a.js", "scripts/b.js"]),
		);

		ledger.recordWrite("scripts/a.js", "landed-last");
		expect(ledger.readLandedBy("landed-last")).toEqual(
			new Set(["scripts/b.js"]),
		);

		ledger.recordLanded("scripts/a.js", "landed-last");
		expect(ledger.readLandedBy("landed-last")).toEqual(
			new Set(["scripts/a.js", "scripts/b.js"]),
		);
	});

	it("answers an empty set for a session that released nothing, and null with no id", () => {
		ledger.recordWrite("scripts/a.js", "landed-none");
		expect(ledger.readLandedBy("landed-none")).toEqual(new Set());
		expect(ledger.readLandedBy("")).toBe(null);
	});
});

describe("the acts ledger (#2308)", () => {
	const commitSha = "c".repeat(40);

	it("reads a session's acts and its commits as one list, every line kept", () => {
		store.recordAct("round owner/repo#5", "alice");
		store.recordAct("round owner/repo#5", "alice");
		store.recordCommit(commitSha, "alice");

		expect(store.readActsBy("alice", [sb.repo])).toEqual({
			acts: ["round owner/repo#5", "round owner/repo#5", `commit ${commitSha}`],
			unreadable: [],
		});
	});

	it("refuses a line that is no act, writing nothing", () => {
		expect(store.recordAct("close #5", "alice")).toBe(false);
		expect(store.recordAct("relabel owner/repo#5 urgent", "alice")).toBe(false);
		expect(store.readActsBy("alice", [sb.repo]).acts).toEqual([]);
	});

	it("tells a store that would not read from one where the session did nothing", () => {
		store.recordAct("file owner/repo#9", "alice");
		const ledgerFile = store.paths.actLedger("alice", sb.repo);
		const quiet = path.join(sb.dir, "other-repo");
		fs.chmodSync(ledgerFile, 0o000);
		try {
			const read = store.readActsBy("alice", [sb.repo, quiet]);
			if (!AS_ROOT) expect(read.unreadable).toEqual([sb.repo]);
			expect(read.acts).toEqual(AS_ROOT ? ["file owner/repo#9"] : []);
		} finally {
			fs.chmodSync(ledgerFile, 0o644);
		}
		expect(store.readActsBy("bob", [sb.repo, quiet])).toEqual({
			acts: [],
			unreadable: [],
		});
	});

	it("is pruned with the commit ledger, sparing a live session", () => {
		store.recordAct("close owner/repo#1", "alice");
		store.recordAct("close owner/repo#2", "bob");
		// bob is registered nowhere, so read as finished.
		live(sb, "alice");
		backdate(store.paths.actLedger("alice", sb.repo));
		backdate(store.paths.actLedger("bob", sb.repo));

		// A third session's first commit runs the commit ledger's sweep.
		store.recordCommit(commitSha, "carol");

		expect(fs.existsSync(store.paths.actLedger("alice", sb.repo))).toBe(true);
		expect(fs.existsSync(store.paths.actLedger("bob", sb.repo))).toBe(false);
	});
});
