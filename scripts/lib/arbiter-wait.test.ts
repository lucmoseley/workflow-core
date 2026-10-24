// @vitest-environment node
/*
 * arbiter-wait.js's own suite: the deadlock walk and `wait`'s verdict table,
 * one reading in and one verdict out (#1500). What needs a process — each
 * verdict's exit code, the want dropped on a signal, the oracle's cadence, one
 * end-to-end DEADLOCK — stays spawned in scripts/session-arbiter.test.ts.
 *
 * `list`'s DEADLOCK block and every blocked `wait` read this walk: loosen a
 * case and two sessions wait on each other unnamed until their ceilings, or a
 * busy holder is reported as a deadlock and its waiter told to release.
 */
import { describe, expect, it } from "vitest";
import {
	core,
	DEAD,
	freshSandbox,
	liveHolder,
	putLock,
	registerSession,
	store,
} from "./arbiter-testkit";
import {
	findCycles,
	issueHolders,
	issueOfWant,
	issueWant,
	nextVerdict,
	ringThrough,
} from "./arbiter-wait.js";

interface Want {
	sessionId: string;
	wants: string;
}
const buildWant = (sessionId: string, wants: string): Want => ({
	sessionId,
	wants,
});

const buildHolderQuery =
	(held: Record<string, string>) => (subject: string, sessionId: string) => {
		const h = held[subject];
		return { holder: h && h !== sessionId ? { sessionId: h } : null };
	};

const buildClaim = (issue: number, sessionId: string) => ({
	issue,
	sessionId,
	claimedAt: "2026-10-14T00:00:00.000Z",
});

const ids = (ring: Want[]) => ring.map((w) => w.sessionId);

describe("issue wants", () => {
	it("names an issue want and reads it back, never a file subject", () => {
		expect(issueOfWant(issueWant(542))).toBe(542);
		expect(issueOfWant("docs/a.md")).toBeNull();
		expect(issueOfWant("issue #0")).toBeNull();
	});

	it("lists every other session's claim on the issue, and null on an unreadable store", () => {
		const claims = [
			buildClaim(540, "alice"),
			buildClaim(540, "bob"),
			buildClaim(541, "c"),
		];
		expect(issueHolders(claims, 540, "bob")).toEqual([claims[0]]);
		expect(issueHolders(null, 540, "bob")).toBeNull();
	});
});

describe("findCycles — the deadlock walk (mantahostels#1195)", () => {
	it("names a two-session ring once, whichever member the walk entered from", () => {
		const cycles = findCycles(
			[buildWant("a", "docs/b.md"), buildWant("b", "docs/a.md")],
			buildHolderQuery({ "docs/a.md": "a", "docs/b.md": "b" }),
			[],
		);
		expect(cycles).toHaveLength(1);
		expect(ids(cycles[0]).sort()).toEqual(["a", "b"]);
	});

	it("finds no ring behind a busy holder that is not itself waiting", () => {
		expect(
			findCycles(
				[buildWant("mine", "docs/a.md")],
				buildHolderQuery({ "docs/a.md": "neighbour" }),
				[],
			),
		).toEqual([]);
	});

	it("ends the walk on an unknown holder rather than asserting a ring (mantahostels#174)", () => {
		expect(
			findCycles(
				[buildWant("a", "docs/b.md"), buildWant("b", "docs/a.md")],
				(subject) =>
					subject === "docs/a.md" ? null : { holder: { sessionId: "b" } },
				[],
			),
		).toEqual([]);
	});

	it("leaves a session leading into a ring out of it, and ringThrough finds it in none", () => {
		const cycles = findCycles(
			[
				buildWant("a", "docs/b.md"),
				buildWant("b", "docs/a.md"),
				buildWant("c", "docs/a.md"),
			],
			buildHolderQuery({ "docs/a.md": "a", "docs/b.md": "b" }),
			[],
		);
		expect(cycles).toHaveLength(1);
		expect(ringThrough(cycles, "c")).toBeNull();
		expect(ids(ringThrough(cycles, "a") ?? []).sort()).toEqual(["a", "b"]);
	});

	it("follows an issue want to its claimant (#542)", () => {
		const cycles = findCycles(
			[buildWant("alice", issueWant(541)), buildWant("bob", issueWant(540))],
			buildHolderQuery({}),
			[buildClaim(540, "alice"), buildClaim(541, "bob")],
		);
		expect(cycles).toHaveLength(1);
		expect(ids(cycles[0]).sort()).toEqual(["alice", "bob"]);
	});

	it("follows the claimant that is itself waiting where an issue has several", () => {
		const cycles = findCycles(
			[buildWant("alice", "docs/b.md"), buildWant("bob", issueWant(540))],
			buildHolderQuery({ "docs/b.md": "bob" }),
			[buildClaim(540, "carol"), buildClaim(540, "alice")],
		);
		expect(cycles).toHaveLength(1);
	});

	it("asserts no ring through an issue want on an unreadable issue-claim store", () => {
		expect(
			findCycles(
				[buildWant("alice", issueWant(541)), buildWant("bob", issueWant(540))],
				buildHolderQuery({}),
				null,
			),
		).toEqual([]);
	});

	describe("over the real holder query", () => {
		const sb = freshSandbox();
		const onDisk = () => {
			const locks = store.readLocks();
			const resumed = core.resumedHolderTest("test", "registry dark");
			return (subject: string, sessionId: string) =>
				store.whoHolds(subject, sessionId, resumed, locks);
		};

		it("still names the ring when a member was RESUMED onto a new pid (#259)", () => {
			// The lock records a dead pid, but the registry has sess-a running on
			// this one: read as dead, the ring breaks in the report while it is
			// still a ring on disk.
			registerSession(sb, "sess-a", process.pid);
			putLock("docs/a.md", { sessionId: "sess-a", ...DEAD });
			putLock("docs/b.md", { sessionId: "sess-b", ...liveHolder() });
			const cycles = findCycles(
				[buildWant("sess-a", "docs/b.md"), buildWant("sess-b", "docs/a.md")],
				onDisk(),
				[],
			);
			expect(cycles).toHaveLength(1);
		});

		it("sees a ring closed by the region umbrella, not just by equal paths", () => {
			// sess-a holds the WHOLE map; sess-b wants one region of it, which only
			// the umbrella rule connects to sess-a's lock (mantahostels#970).
			putLock("docs/doc-map.md", { sessionId: "sess-a", ...liveHolder() });
			putLock("docs/other.md", { sessionId: "sess-b", ...liveHolder() });
			const cycles = findCycles(
				[
					buildWant("sess-a", "docs/other.md"),
					buildWant("sess-b", "docs/doc-map.md#B999"),
				],
				onDisk(),
				[],
			);
			expect(cycles).toHaveLength(1);
		});
	});
});

describe("nextVerdict — wait's table, one poll at a time (#540, #542)", () => {
	const alice = { sessionId: "alice" };
	const ring = [buildWant("bob", "docs/a.md"), buildWant("alice", "docs/b.md")];
	const never = () => {
		throw new Error("read where the table never reaches it");
	};

	it("is NOT-HELD on a first poll that finds the target free, and waits on a held one", () => {
		expect(nextVerdict({ poll: { free: null }, first: true })).toEqual({
			verdict: "NOT-HELD",
		});
		expect(
			nextVerdict({ poll: { held: alice }, first: true, ring: never }),
		).toBeNull();
	});

	it("is RELEASED once the claim is gone, and HOLDER-DEAD where a dead one is still on disk", () => {
		expect(nextVerdict({ poll: { free: null }, ring: never })).toEqual({
			verdict: "RELEASED",
		});
		expect(nextVerdict({ poll: { free: alice }, ring: never })).toEqual({
			verdict: "HOLDER-DEAD",
		});
	});

	it("frees before the ceiling: a release at the deadline is still RELEASED", () => {
		expect(nextVerdict({ poll: { free: null }, left: () => 0 })?.verdict).toBe(
			"RELEASED",
		);
	});

	it("is DEADLOCK on a ring through this session, before the oracle is read", () => {
		expect(
			nextVerdict({ poll: { held: alice }, ring: () => ring, terminal: never }),
		).toEqual({ verdict: "DEADLOCK", ring });
	});

	it("is HOLDER-ENDED where the oracle calls the holder terminal", () => {
		expect(
			nextVerdict({
				poll: { held: alice },
				ring: () => null,
				terminal: () => new Set(["alice"]),
			}),
		).toEqual({ verdict: "HOLDER-ENDED" });
	});

	it("waits on where only one of an issue's claimants has ended", () => {
		const poll = { held: alice, holders: [alice, { sessionId: "carol" }] };
		expect(
			nextVerdict({
				poll,
				ring: () => null,
				terminal: () => new Set(["alice"]),
			}),
		).toBeNull();
		expect(
			nextVerdict({
				poll,
				ring: () => null,
				terminal: () => new Set(["alice", "carol"]),
			}),
		).toEqual({ verdict: "HOLDER-ENDED" });
	});

	it("never calls a holder naming no session ended", () => {
		expect(
			nextVerdict({
				poll: { held: { sessionId: null } },
				ring: () => null,
				terminal: () => new Set(["alice"]),
			}),
		).toBeNull();
	});

	it("waits on where the oracle refused or no read is due, until the ceiling", () => {
		const poll = { held: alice };
		expect(
			nextVerdict({ poll, ring: () => null, terminal: () => undefined }),
		).toBeNull();
		expect(nextVerdict({ poll, ring: () => null })).toBeNull();
		expect(nextVerdict({ poll, ring: () => null, left: () => 0 })).toEqual({
			verdict: "CEILING",
		});
	});

	it("never frees on doubt: a poll neither held nor free reads no ring and only reaches CEILING", () => {
		const poll = { doubt: "the claim store could not be read" };
		expect(nextVerdict({ poll, ring: never, terminal: never })).toBeNull();
		expect(
			nextVerdict({ poll, ring: never, terminal: never, left: () => 0 }),
		).toEqual({ verdict: "CEILING" });
	});
});
