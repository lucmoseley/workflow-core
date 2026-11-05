// @vitest-environment node
/*
 * Pins which issues pick-next reports as naming the same repo file (#4329):
 * two frontier candidates (mantahostels#192), and a candidate with an issue
 * a live session is on (mantahostels#384, mantahostels#708).
 *
 * Loosen a case and a run warns against the very issue it offers, or stays
 * silent while a candidate's session would write under a live one.
 */
import { describe, expect, it } from "vitest";

const {
	annotatePaths,
	collisionBlockLines,
	collisionsOf,
} = require("./pick-next-collisions.js");

const tracked = { ok: true, files: ["scripts/a.js"] };
const issue = (number: number, assignees: string[] = []) => ({
	number,
	assignees,
	body: "`scripts/a.js`",
});

describe("frontier and in-flight pairs", () => {
	it("pairs a candidate only with an issue a live session is on", () => {
		const one = issue(1);
		const two = issue(2, ["luc"]);
		// Claimed: in flight, and out of the frontier.
		const claimed = collisionsOf(
			annotatePaths([one], tracked),
			[one, two],
			new Map([[2, "alice"]]),
			tracked,
		);
		expect(claimed.collisions).toEqual([]);
		expect(claimed.inFlightCollisions).toMatchObject([
			{ candidate: 1, inFlight: 2 },
		]);
		// Unclaimed: the run offers #2 itself, so it is an ordinary candidate pair.
		const open = collisionsOf(
			annotatePaths([one, two], tracked),
			[one, two],
			new Map(),
			tracked,
		);
		expect(open.inFlightCollisions).toEqual([]);
		expect(open.collisions).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
	});

	it("carries the session alongside the assignee, not instead of it", () => {
		const one = issue(1);
		const two = issue(2, ["luc"]);
		const { inFlightCollisions } = collisionsOf(
			annotatePaths([one], tracked),
			[one, two],
			new Map([[2, "alice"]]),
			tracked,
		);
		expect(inFlightCollisions[0]).toEqual({
			candidate: 1,
			inFlight: 2,
			claimedBy: ["luc"],
			claimedSession: "alice",
			paths: ["scripts/a.js"],
		});
	});
});

describe("the POSSIBLE FILE COLLISIONS lines", () => {
	const pair = (a: number, b: number, paths: string[]) => ({ a, b, paths });
	const lines = (
		collisions: ReturnType<typeof pair>[],
		{ docMapQueue = [] as number[], inFlight = 0 } = {},
	) =>
		collisionBlockLines({
			tracked,
			collisions,
			inFlightCollisions: Array.from({ length: inFlight }, (_, k) => ({
				candidate: 1,
				inFlight: k + 2,
				claimedBy: ["luc"],
				claimedSession: "self",
				paths: ["scripts/a.js"],
			})),
			docMapQueue,
			claims: { kept: true },
			listed: { names: new Map() },
		}).join("\n");

	it("suppresses a pair sharing only docs/doc-map.md behind a summary count", () => {
		// The doc-map-only wall the skill tells the reader to discount (.claude/skills/pick-next/SKILL.md; mantahostels#593).
		const out = lines([
			pair(1, 2, ["docs/doc-map.md"]),
			pair(1, 3, ["docs/doc-map.md"]),
			pair(2, 3, ["docs/doc-map.md"]),
		]);
		expect(out).not.toMatch(/possible collision:/);
		expect(out).toMatch(
			/3 pairs sharing only a stamp path \(docs\/doc-map\.md\) suppressed; --json carries every pair\./,
		);
		expect(out).not.toMatch(/DOC-MAP QUEUE/);
	});

	it("suppresses a pair sharing only CLAUDE.md, the other ruled stamp path (mantahostels#1301, mantahostels#1312)", () => {
		const out = lines([pair(1, 2, ["CLAUDE.md"])]);
		expect(out).not.toMatch(/possible collision:/);
		expect(out).toMatch(
			/1 pair sharing only a stamp path \(CLAUDE\.md\) suppressed;/,
		);
		expect(out).not.toMatch(/docs\/doc-map\.md/);
	});

	it("does not point a CLAUDE.md-only suppression at the DOC-MAP QUEUE (mantahostels#1312)", () => {
		const out = lines([pair(1, 2, ["CLAUDE.md"])], { docMapQueue: [3] });
		expect(out).toMatch(
			/1 pair sharing only a stamp path \(CLAUDE\.md\) suppressed; --json/,
		);
		expect(
			lines([pair(1, 2, ["docs/doc-map.md"])], { docMapQueue: [1] }),
		).toMatch(
			/\(docs\/doc-map\.md\) suppressed — see the DOC-MAP QUEUE below;/,
		);
	});

	it("still prints, in full, a pair sharing docs/doc-map.md plus a second path", () => {
		const out = lines([pair(1, 2, ["docs/doc-map.md", "scripts/a.js"])]);
		expect(out).toMatch(
			/possible collision: #1 <-> #2 on docs\/doc-map\.md, scripts\/a\.js/,
		);
		expect(out).not.toMatch(/suppressed/);
	});

	it("caps the printed in-flight pairs and says how many it withheld", () => {
		const out = lines([], { inFlight: 156 });
		expect(out.match(/in flight:/g)).toHaveLength(20);
		expect(out).toMatch(
			/\.\.\. and 136 more in-flight pairs — --json carries every one\./,
		);
		expect(lines([], { inFlight: 20 })).not.toMatch(/more in-flight pairs/);
	});

	it("prints nothing where no pair fired, and says the block is unavailable where git listed no files", () => {
		expect(lines([])).toBe("");
		expect(
			collisionBlockLines({
				tracked: { ok: false, error: "git ls-files failed" },
				collisions: [],
				inFlightCollisions: [],
				docMapQueue: [],
				claims: {},
				listed: {},
			}),
		).toEqual([
			"\nPOSSIBLE FILE COLLISIONS — unavailable: could not list tracked files\n  git ls-files failed",
		]);
	});
});
