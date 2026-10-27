// @vitest-environment node
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type Kind = "block" | "close" | "file" | "relabel" | "round";
const { ACT_LINE, buildAct, commitAct, parseAct } = createRequire(__filename)(
	"./act-line.js",
) as {
	ACT_LINE: RegExp;
	buildAct: (kind: Kind, repo: string, n: number, takes?: string) => string;
	commitAct: (sha: string) => string;
	parseAct: (line: string) => { kind: string; ref: string; takes?: string };
};

describe("act line", () => {
	it.each(["block", "close", "file", "round"] as const)(
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
		const line = commitAct("a".repeat(40));
		expect(line).not.toMatch(ACT_LINE);
		expect(parseAct(line)).toEqual({ kind: "commit", ref: "a".repeat(40) });
	});
});
