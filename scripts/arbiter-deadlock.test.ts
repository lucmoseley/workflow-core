// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	arbiterCli,
	breaks,
	freshSandbox,
	live,
	registerSession,
	store,
} from "./lib/arbiter-testkit";

const sb = freshSandbox();

const { cli, readListing } = arbiterCli(sb);

const inRepo = (rel: string) => path.join(sb.repo, rel);
const readHeldPaths = () =>
	(store.readLocks() ?? [])
		.filter((l: { unreadable?: boolean }) => !l.unreadable)
		.map((l: { path: string }) => l.path)
		.sort();

const neighbourHolds = (sessionId: string, subject: string) => {
	const me = live(sb, sessionId);
	const { verdict } = store.acquire(subject, me);
	expect(verdict).toBe("claimed");
};

const claimsIssue = (sessionId: string, n: number) =>
	expect(store.claimIssue(n, store.identify(sessionId)).status).toBe("claimed");

const waitsOn = (sessionId: string, n: number) =>
	store.recordWant(`issue #${n}`, store.identify(sessionId));

const readClaimedIssues = () =>
	(store.listIssueClaims()?.claims ?? [])
		.map((c: { issue: number }) => c.issue)
		.sort();

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
		expect(r.stderr).toContain("not-a-region");
	});
});

describe("the waiter register (mantahostels#1195)", () => {
	it("forgets a want whose session is gone", () => {
		live(sb, "mine");
		waitsOn("mine", 540);
		const f = store.paths.want("mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readWants()).toEqual([]);
	});
});

describe("the cycle report under list (mantahostels#1195)", () => {
	const buildCycle = () => {
		registerSession(sb, "sess-a", process.ppid);
		registerSession(sb, "sess-b", process.pid);
		const a = store.identify("sess-a");
		const b = store.identify("sess-b");
		expect(a.durable).toBe(true);
		expect(b.durable).toBe(true);
		claimsIssue("sess-a", 540);
		claimsIssue("sess-b", 541);
		waitsOn("sess-a", 541);
		waitsOn("sess-b", 540);
	};

	it("names a two-session cycle as a deadlock, once", () => {
		buildCycle();
		const listing = readListing(["list"]);
		expect(listing).toContain("DEADLOCK  2 session(s)");
		expect(listing.match(/DEADLOCK/g)).toHaveLength(1);
		expect(listing).toContain("sess-a");
		expect(listing).toContain("sess-b");
	});

	it("tells the reader which act breaks it", () => {
		buildCycle();
		const listing = readListing(["list"]);
		expect(listing).toContain("release-issue <n>");
		expect(listing).toContain("ends its wait");
	});

	it("calls a waiter behind a busy claimant WAITING, never a deadlock", () => {
		live(sb, "neighbour");
		claimsIssue("neighbour", 540);
		live(sb, "mine");
		waitsOn("mine", 540);
		const listing = readListing(["list"]);
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

	it("reports the cycle without releasing anything", () => {
		buildCycle();
		readListing(["list"]);
		expect(readClaimedIssues()).toEqual([540, 541]);
	});
});

describe("the write hook route (mantahostels#1195, #4249)", () => {
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
});

describe("claim-all keeps the notices claim gives (mantahostels#1195's review)", () => {
	it("passes on a break notice for a subject it took", () => {
		live(sb, "mine");
		breaks.recordBreak(
			"docs/a.md",
			{ sessionId: "mine", claimId: "lost-claim" },
			live(sb, "neighbour"),
		);
		const r = cli(["claim-all", inRepo("docs/a.md"), inRepo("docs/b.md")], {
			CLAUDE_CODE_SESSION_ID: "mine",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("claim on docs/a.md was broken");
	});
});

describe("what the code review found", () => {
	it("says the waiter register is unreadable rather than printing silence", () => {
		live(sb, "mine");
		cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "mine" });
		fs.writeFileSync(store.paths.wantsDir(), "not a directory");
		const r = cli(["list"], {});
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("could not be read");
		expect(r.stdout).toContain("docs/a.md");
	});

	it("keeps a resumed waiter's record instead of deleting it", () => {
		live(sb, "mine");
		waitsOn("mine", 540);
		const f = store.paths.want("mine");
		const rec = JSON.parse(fs.readFileSync(f, "utf8"));
		fs.writeFileSync(f, JSON.stringify({ ...rec, procStart: "999999999" }));
		expect(store.readWants()).toEqual([]);
		expect(fs.existsSync(f)).toBe(true);
	});
});
