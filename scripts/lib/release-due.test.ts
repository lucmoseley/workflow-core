// @vitest-environment node
import { describe, expect, it } from "vitest";

const { judgeCut } = require("./release-due.js");

describe("judgeCut", () => {
	it("is due where a note newer than the tag owes a step, naming each note and its count", () => {
		const v = judgeCut({
			tag: "v1.0.0",
			owed: [
				{ note: "migrations/v1.1.0.md", steps: 2 },
				{ note: "migrations/v1.2.0.md", steps: 1 },
			],
		});
		expect(v.due).toBe(true);
		expect(v.why).toContain(
			"migrations/v1.1.0.md (2), migrations/v1.2.0.md (1)",
		);
	});

	it("is not due where no newer note owes a step", () => {
		const v = judgeCut({ tag: "v1.0.0", owed: [] });
		expect(v.due).toBe(false);
		expect(v.why).toContain("no migration note newer than v1.0.0");
	});
});
