// @vitest-environment node
/*
 * Pins which issues pick-next reports as naming the same repo file (#4329):
 * two frontier candidates (mantahostels#192), and a candidate with an issue
 * a live session is on (mantahostels#384, mantahostels#708).
 *
 * Loosen a case and a run warns against the very issue it offers, or stays
 * silent while a candidate's session would write under a live one.
 *
 * Pure over issues and a seeded tracked-file list; the git read stays in the
 * program's own cases.
 */
import { describe, expect, it } from "vitest";

const { annotatePaths, collisionsOf } = require("./pick-next-collisions.js");

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
