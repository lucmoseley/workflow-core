// @vitest-environment node
import { describe, expect, it } from "vitest";

const { reportGroupedHits } = require("./grouped-hits");

function recorder() {
	const log: unknown[][] = [];
	const ctx = {
		say: (...a: unknown[]) => log.push(["say", ...a]),
		warn: (...a: unknown[]) => log.push(["warn", ...a]),
	};
	return { ctx, log };
}

const report = {
	keyOf: (h: { id: string }) => [h.id, "x"],
	summary: (groups: number) => `${groups} group(s):\n`,
	groupFinding: (h: { id: string }, count: number) => ({
		tag: "TAG",
		message: `${h.id} × ${count}`,
		data: { id: h.id, count },
		heading: `§${h.id}`,
	}),
	footer: "footer",
};

describe("reportGroupedHits", () => {
	it("prints nothing for no hits", () => {
		const { ctx, log } = recorder();
		reportGroupedHits(ctx, [], report);
		expect(log).toEqual([]);
	});

	it("groups in first-hit order, one warn per group read off its first hit", () => {
		const { ctx, log } = recorder();
		reportGroupedHits(
			ctx,
			[
				{ id: "B2", file: "a.md", line: 1, text: "one" },
				{ id: "B1", file: "b.md", line: 2, text: "two" },
				{ id: "B2", file: "c.md", line: 3, text: "three" },
			],
			report,
		);
		expect(log).toEqual([
			["say", "2 group(s):\n"],
			["warn", "TAG", "B2 × 2", { id: "B2", count: 2 }, "TAG\tB2\tx"],
			["say", "§B2"],
			["say", "  a.md:1  one"],
			["say", "  c.md:3  three"],
			["say"],
			["warn", "TAG", "B1 × 1", { id: "B1", count: 1 }, "TAG\tB1\tx"],
			["say", "§B1"],
			["say", "  b.md:2  two"],
			["say"],
			["say", "footer"],
		]);
	});
});
