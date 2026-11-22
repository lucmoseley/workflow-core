// @vitest-environment node
import { describe, expect, it } from "vitest";
import { carrySessionBar } from "./session-bar-carry.js";

const SESSION_LINE = "Current session: 37% used · resets Oct 28, 12:20am (UTC)";
const WEEK_LINE =
	"Current week (all models): 96% used · resets Nov 1, 8pm (UTC)";
const SESSION_LIMIT = { kind: "session", percent: 37 };
const WEEK_LIMIT = { kind: "weekly_all", percent: 96 };

const recording = (harness: string, withSession: boolean) => ({
	harness,
	printed: withSession ? [SESSION_LINE, WEEK_LINE] : [WEEK_LINE],
	cache: {
		utilization: {
			limits: withSession ? [SESSION_LIMIT, WEEK_LIMIT] : [WEEK_LIMIT],
		},
	},
});

describe("carrySessionBar (#5332)", () => {
	it("records a probe listing a session bar as probed", () => {
		const probe = recording("2.1.326", true);
		expect(carrySessionBar(probe, recording("2.1.311", true))).toBe(probe);
	});

	it("carries the previous recording's session bar under its harness", () => {
		expect(
			carrySessionBar(recording("2.1.326", false), recording("2.1.311", true))
				.sessionBar,
		).toEqual({
			harness: "2.1.311",
			printed: SESSION_LINE,
			limit: SESSION_LIMIT,
		});
	});

	it("carries a bar the previous recording itself carried", () => {
		const previous = carrySessionBar(
			recording("2.1.326", false),
			recording("2.1.311", true),
		);
		expect(
			carrySessionBar(recording("2.1.330", false), previous).sessionBar
				?.harness,
		).toBe("2.1.311");
	});

	it("refuses a session-less probe with nothing to carry, naming the remedy", () => {
		expect(() => carrySessionBar(recording("2.1.326", false), null)).toThrow(
			/five-hour window open/,
		);
		expect(() =>
			carrySessionBar(recording("2.1.326", false), recording("2.1.311", false)),
		).toThrow(/no earlier recording/);
	});

	it("refuses a bar printed but not cached, or the reverse", () => {
		const printedOnly = {
			...recording("2.1.326", true),
			cache: { utilization: { limits: [WEEK_LIMIT] } },
		};
		expect(() => carrySessionBar(printedOnly, null)).toThrow(
			/printed a session bar/,
		);
		const cachedOnly = { ...recording("2.1.326", true), printed: [WEEK_LINE] };
		expect(() => carrySessionBar(cachedOnly, null)).toThrow(
			/cached a session bar/,
		);
	});
});
