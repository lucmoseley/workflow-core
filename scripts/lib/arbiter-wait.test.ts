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

const buildClaim = (issue: number, sessionId: string) => ({
	issue,
	sessionId,
	claimedAt: "2026-10-14T00:00:00.000Z",
});

const ids = (ring: Want[]) => ring.map((w) => w.sessionId);

describe("issue wants", () => {
	it("names an issue want and reads it back, and null for any other subject", () => {
		expect(issueOfWant(issueWant(542))).toBe(542);
		expect(issueOfWant("issue 542")).toBeNull();
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
	it("follows an issue want to its claimant, naming a two-session ring once (#542)", () => {
		const cycles = findCycles(
			[buildWant("alice", issueWant(541)), buildWant("bob", issueWant(540))],
			[buildClaim(540, "alice"), buildClaim(541, "bob")],
		);
		expect(cycles).toHaveLength(1);
		expect(ids(cycles[0]).sort()).toEqual(["alice", "bob"]);
	});

	it("finds no ring behind a busy claimant that is not itself waiting", () => {
		expect(
			findCycles(
				[buildWant("mine", issueWant(540))],
				[buildClaim(540, "neighbour")],
			),
		).toEqual([]);
	});

	it("leaves a session leading into a ring out of it, and ringThrough finds it in none", () => {
		const cycles = findCycles(
			[
				buildWant("a", issueWant(541)),
				buildWant("b", issueWant(540)),
				buildWant("c", issueWant(540)),
			],
			[buildClaim(540, "a"), buildClaim(541, "b")],
		);
		expect(cycles).toHaveLength(1);
		expect(ringThrough(cycles, "c")).toBeNull();
		expect(ids(ringThrough(cycles, "a") ?? []).sort()).toEqual(["a", "b"]);
	});

	it("follows the claimant that is itself waiting where an issue has several", () => {
		const cycles = findCycles(
			[buildWant("alice", issueWant(541)), buildWant("bob", issueWant(540))],
			[
				buildClaim(541, "bob"),
				buildClaim(540, "carol"),
				buildClaim(540, "alice"),
			],
		);
		expect(cycles).toHaveLength(1);
	});

	it("asserts no ring through an issue want on an unreadable issue-claim store", () => {
		expect(
			findCycles(
				[buildWant("alice", issueWant(541)), buildWant("bob", issueWant(540))],
				null,
			),
		).toEqual([]);
	});
});

describe("nextVerdict — wait's table, one poll at a time (#540, #542)", () => {
	const alice = { sessionId: "alice" };
	const ring = [
		buildWant("bob", issueWant(540)),
		buildWant("alice", issueWant(541)),
	];
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

	it("is RELEASED once the claim is gone", () => {
		expect(nextVerdict({ poll: { free: null }, ring: never })).toEqual({
			verdict: "RELEASED",
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
