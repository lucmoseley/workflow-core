import { describe, expect, it } from "vitest";
import { withoutHeadShaLines } from "./head-sha-lines";

const SHA = "92d78df557aa843d6cbf08f1db5c2792003a5853";

describe("withoutHeadShaLines (#5777)", () => {
	it("drops the base-red ticket's Main line and keeps the rest", () => {
		const body = [
			"## What to build",
			"",
			`- Main: \`${SHA}\``,
			"",
			"Failing:",
			"- `scripts/lib/pypi-registry.contract.test.ts`",
		].join("\n");
		const kept = withoutHeadShaLines(body);
		expect(kept).not.toContain(SHA);
		expect(kept).toContain("pypi-registry.contract.test.ts");
	});

	it("drops the red-suite ticket's whole red-run section up to the next heading", () => {
		const body = [
			"Filed automatically by `scripts/report-red-suite.js`.",
			"",
			"## The red run",
			"",
			`- **Head sha:** \`${SHA}\``,
			"```",
			"  92d78df55  Address #5399's review",
			"```",
			"",
			"## Read this before hunting a commit",
			"",
			"Reproduce on the head sha.",
		].join("\n");
		const kept = withoutHeadShaLines(body);
		expect(kept).not.toMatch(/92d78df|#5399/);
		expect(kept).toContain("## Read this before hunting a commit");
		expect(kept).toContain("Reproduce on the head sha.");
	});

	it("keeps a sha a person cites in prose", () => {
		const body = `Since ${SHA.slice(0, 9)} the lander hangs.`;
		expect(withoutHeadShaLines(body)).toBe(body);
	});
});
