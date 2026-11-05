// @vitest-environment node
/*
 * The deadlock half of the arbiter: taking a set of subjects in one call, and
 * naming a cycle of waits once one exists (mantahostels#1195).
 *
 * Spawned rather than called in-process: what these guarantees are worth is the
 * exit code a caller branches on and the stdout a person reads, and both are
 * process-level facts.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	arbiterCli,
	freshSandbox,
	live,
	registerSession,
	store,
} from "./lib/arbiter-testkit";

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

/** `sessionId` waiting on `subject`, as `wait <path>` records it; the cycle walk reads the holder off the locks. */
const waitsOn = (sessionId: string, subject: string) =>
	store.recordWant(subject, store.identify(sessionId));

describe("claim-all: every subject in one call", () => {
	it("takes every subject when all are free", () => {
		live(sb, "mine");
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(readHeldPaths()).toEqual(["docs/a.md", "docs/b.md"]);
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
});

describe("the waiter register (mantahostels#1195)", () => {
	it("drops the record the moment the session claims anything", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		waitsOn("mine", "docs/a.md");
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
		waitsOn("mine", "docs/a.md");
		// Rewrite the record onto a pid/start pair that cannot be alive.
		const f = store.paths.want("mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readWants()).toEqual([]);
	});
});

describe("the cycle report under list (mantahostels#1195)", () => {
	/** Two sessions, each holding what the other waits on. */
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
		waitsOn("sess-a", "docs/b.md");
		waitsOn("sess-b", "docs/a.md");
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
		expect(listing).toContain("end a file wait");
	});

	it("calls a waiter behind a busy holder WAITING, never a deadlock", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		waitsOn("mine", "docs/a.md");
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
		// sess-a holds the WHOLE map; sess-b holds an unrelated file. sess-b waits
		// on one region of the map, which only the umbrella rule connects to
		// sess-a's whole-file lock (mantahostels#970).
		expect(store.acquire("docs/doc-map.md", a).verdict).toBe("claimed");
		expect(store.acquire("docs/other.md", b).verdict).toBe("claimed");
		waitsOn("sess-a", "docs/other.md");
		waitsOn("sess-b", "docs/doc-map.md#B999");
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

describe("the write hook route (mantahostels#1195, #4249)", () => {
	/** The PreToolUse hook route: lib/file-claim.js runs `check`, never `claim`. */
	const check = (sessionId: string, rel: string) =>
		cli(["check", inRepo(rel), sessionId], {
			CLAUDE_CODE_SESSION_ID: sessionId,
		});

	it("warns of the likely merge conflict on a file a neighbour holds, and records no want (#4249)", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		const r = check("mine", "docs/a.md");
		expect(r.stdout).not.toContain("permissionDecision");
		expect(r.stdout).toContain("docs/a.md is also held by session");
		expect(r.stdout).toContain("merge conflict");
		expect(store.readWants()).toEqual([]);
	});

	it("drops the want when the hook route takes a claim", () => {
		neighbourHolds("neighbour", "docs/a.md");
		live(sb, "mine");
		waitsOn("mine", "docs/a.md");
		expect(store.readWants()).toHaveLength(1);
		check("mine", "docs/b.md");
		expect(store.readWants()).toEqual([]);
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
		waitsOn("mine", "docs/a.md");
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
