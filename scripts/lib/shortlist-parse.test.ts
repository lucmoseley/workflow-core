/*
 * shortlist-parse.test.ts — the refill loop's read of a shortlist's conflict
 * graph (#4355): each row gets its write-set and held-file overlap, and a
 * shortlist without the graph fails rather than reads clash-free. Holds
 * lib/shortlist-fake.ts, the shortlist the refill loop's run tests stub, to
 * what the parser requires (#4358).
 */

import { describe, expect, it } from "vitest";
import { buildShortlist, shortlistRow } from "./shortlist-fake";

const { parseShortlist } = require("./shortlist-parse.js");

describe("parseShortlist's write-sets (#4355)", () => {
	const shortlist = (conflictGraph: unknown) =>
		JSON.stringify({
			frontier: [{ number: 1 }, { number: 2 }, { number: 3 }],
			retroBundles: [],
			pulledIn: [],
			pulledInUnread: [],
			ownRepo: "o/r",
			goalSet: null,
			running: [],
			conflictGraph,
		});

	it("gives each row its predicted write-set and the substrate a session holds", () => {
		const out = parseShortlist(
			shortlist({
				candidates: [
					{ number: 1, writeSet: ["a.js", "docs/doc-map.md"] },
					{ number: 2, writeSet: ["b.js"] },
				],
				inFlight: [
					{
						candidate: 2,
						paths: ["b.js"],
						session: "Implement 9",
						sessionId: "s-9",
					},
				],
			}),
		);
		expect(out.rows).toEqual([
			{ number: 1, writeSet: ["a.js", "docs/doc-map.md"] },
			{
				number: 2,
				writeSet: ["b.js"],
				heldBy: { paths: ["b.js"], session: "Implement 9", sessionId: "s-9" },
			},
			{ number: 3, writeSet: [] },
		]);
	});

	it("fails a shortlist with no conflict graph rather than read it clash-free", () => {
		expect(parseShortlist(shortlist(undefined))).toEqual({
			error: "unparseable --json: no conflictGraph candidates or inFlight list",
		});
	});
});

describe("the run tests' shortlist fake (#4358)", () => {
	it("parses clean", () => {
		const out = parseShortlist(
			JSON.stringify(buildShortlist({ frontier: [shortlistRow()] })),
		);
		expect(out).not.toHaveProperty("error");
		expect(out.rows).toEqual([{ ...shortlistRow(), writeSet: [] }]);
	});
});
