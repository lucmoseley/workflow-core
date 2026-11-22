// @vitest-environment node
import { describe, expect, it } from "vitest";

const { CADENCE_DAYS, daysSinceCut, judgeCut } = require("./release-due.js");

const DAY_MS = 86_400_000;
const CUT = 1_790_000_000;
const at = (days: number) => CUT * 1000 + days * DAY_MS;
const reading = (commits: number) => ({ tag: "v1.0.0", cutSec: CUT, commits });

describe("judgeCut", () => {
	it("is not due a moment inside the cadence, naming when a cut is allowed", () => {
		const v = judgeCut(reading(5), at(CADENCE_DAYS) - 1);
		expect(v.due).toBe(false);
		expect(v.why).toContain(
			`allowed from ${new Date(at(CADENCE_DAYS)).toISOString().slice(0, 16).replace("T", " ")} UTC`,
		);
	});

	it("is due at the cadence's edge with a commit to release", () => {
		const v = judgeCut(reading(1), at(CADENCE_DAYS));
		expect(v.due).toBe(true);
		expect(v.why).toContain("1 commit(s) it does not carry");
	});

	it("is not due past the cadence with nothing to release", () => {
		const v = judgeCut(reading(0), at(30));
		expect(v.due).toBe(false);
		expect(v.why).toContain("holds no commit it does not carry");
	});
});

describe("daysSinceCut", () => {
	it("counts fractional days from the tag", () => {
		expect(daysSinceCut(CUT, at(1.5))).toBe(1.5);
	});
});
