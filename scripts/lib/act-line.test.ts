// @vitest-environment node
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
