// @vitest-environment node
/*
 * The acts ledger's line format (#3264): each line buildAct and
 * buildCommitAct build, ACT_LINE's verdict on it, and parseAct's split of it.
 * The module is pure, so the cases call it in process and touch no disk.
 *
 * Loosen one and a writer's line is refused by the ledger, a commit line
 * lands in the acts ledger, or the refill loop's progress test misreads a
 * launch's acts.
 *
 * The kinds are listed by hand, not read from act-line.js, so a kind deleted
 * there fails its own case; a kind added there gets none (#3312).
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { ACT_LINE, buildAct, buildCommitAct, parseAct } = createRequire(
	__filename,
)("./act-line.js") as typeof import("./act-line.js");

describe("act line", () => {
	it.each(["block", "close", "file", "gate", "round"] as const)(
		"builds a %s line ACT_LINE accepts and parseAct takes apart",
		(kind) => {
			const line = buildAct(kind, "owner/repo", 12);
			expect(line).toMatch(ACT_LINE);
			expect(parseAct(line)).toEqual({ kind, ref: "owner/repo#12" });
		},
	);

	it("carries a relabel's takes: label through both", () => {
		const line = buildAct("relabel", "owner/repo", 3, "takes:implement");
		expect(line).toMatch(ACT_LINE);
		expect(parseAct(line)).toEqual({
			kind: "relabel",
			ref: "owner/repo#3",
			takes: "takes:implement",
		});
	});

	it("parses a commit line, which ACT_LINE keeps out of the acts ledger", () => {
		const line = buildCommitAct("a".repeat(40));
		expect(line).not.toMatch(ACT_LINE);
		expect(parseAct(line)).toEqual({ kind: "commit", ref: "a".repeat(40) });
	});
});
