// @vitest-environment node
/*
 * lib/main-checkout-cutover.js judges each reading (#4688, #5276). Loosened, a
 * cut-over checkout runs the cutover again, an occupied one passes, or a
 * refusal reads as cut over.
 */
import { describe, expect, it } from "vitest";

const { judgeCutover } = require("./main-checkout-cutover.js");

type Run = () => { result: unknown; lines: string[] };
const neverRun: Run = () => {
	throw new Error("cutover run");
};
const judge = (cutOver: boolean | null, runCutover: Run = neverRun) =>
	judgeCutover({ cutOver: () => cutOver, runCutover });

describe("judgeCutover (#5276)", () => {
	it("passes a cut-over main checkout without running the cutover", () => {
		expect(judge(true)).toMatchObject({ outcome: "ok", lines: [] });
	});

	it("is broken where git cannot read the mark", () => {
		expect(judge(null).outcome).toBe("broken");
	});

	it("runs the cutover where the main checkout is not cut over, passing with its report", () => {
		const r = judge(false, () => ({
			result: { status: "cut-over" },
			lines: ["the main checkout is cut over"],
		}));
		expect(r).toMatchObject({
			outcome: "ok",
			lines: ["the main checkout is cut over"],
		});
	});

	it("fails naming each session standing in the main checkout", () => {
		const r = judge(false, () => ({
			result: { status: "occupied", sessions: ["alpha", "beta"] },
			lines: [],
		}));
		expect(r).toMatchObject({ outcome: "fail", tag: "OCCUPIED" });
		expect(r.line).toContain("2 session(s) stand in it: alpha, beta");
	});

	it("fails carrying the report of any other refusal", () => {
		const r = judge(false, () => ({
			result: { status: "unlisted", why: "no oracle" },
			lines: ["refused: no session listing"],
		}));
		expect(r).toMatchObject({ outcome: "fail", tag: "NOT-CUT-OVER" });
		expect(r.line).toContain("refused: no session listing");
	});

	it("skips while another run holds the cutover", () => {
		const r = judge(false, () => ({ result: { status: "busy" }, lines: [] }));
		expect(r.outcome).toBe("skip");
	});
});
