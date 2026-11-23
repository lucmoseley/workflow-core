// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseWindow } from "./gate-window.js";

const FISHER_4093 =
	"the leap rate per VM boot after the install is below the baseline's; baseline 3/30 VM boots on a Windows up over 30 minutes (10.0%, #4081's census); target the baseline point; 95% one-sided, one-sided Fisher exact test; pass = 0 leaps in n = 50 boots (about 33 days at 1.5 boots a day); fail at the first leap";
const CONDITIONAL_5346 =
	"the reset rate per precondition minute is below the baseline's; baseline 3/1842 precondition minutes (`~/memwatch-minute.jsonl`); target the baseline point; 80% one-sided (founder ruling, #5449 Q2), exact conditional two-rate Poisson test (Przyborowski and Wilenski 1940); pass = 0 resets in n = 1308 precondition minutes (759 more); fail at the first reset";
const CONDITIONAL_DAYS =
	"baseline 4/8.65 days (#5346, 4–12 Nov); target the baseline point; 95% one-sided, conditional Poisson test; pass = 0 resets in n = 9.64 days";
const BINOMIAL_EXAMPLE =
	"baseline 27/449 attempts (6.0%, #4855, 5–10 Nov); target 4.28% (a stated SLO, #4855); 95% one-sided, exact binomial; pass = 0 refusals in n = 69 attempts";

describe("parseWindow — a basis's window from its own figures (#5406)", () => {
	it.each([
		["#4093's re-gate, one-sided Fisher", FISHER_4093, "50"],
		["#5346's basis, the conditional test at 80%", CONDITIONAL_5346, "1308"],
		["a time window to its stated decimals", CONDITIONAL_DAYS, "9.64"],
		["the fixed-target worked example", BINOMIAL_EXAMPLE, "69 to 71"],
		[
			"a one-event Fisher baseline, the least n with N ÷ (N + n) ≤ α",
			FISHER_4093.replace("3/30", "1/10").replace("n = 50", "n = 190"),
			"190",
		],
	])("passes %s", (_name, basis, computed) => {
		expect(parseWindow(basis)).toMatchObject({ holds: true, computed });
	});

	it("refuses a stated n its figures do not give", () => {
		expect(
			parseWindow(FISHER_4093.replace("n = 50 boots", "n = 107 boots")),
		).toMatchObject({
			method: "fisher",
			stated: "107",
			computed: "50",
			holds: false,
		});
		expect(
			parseWindow(CONDITIONAL_DAYS.replace("9.64 days", "19 days")),
		).toMatchObject({ computed: "10", holds: false });
	});

	it("sizes a target at the baseline's lower bound by the two-sample test (#5401)", () => {
		const inflated =
			"the leap rate is below the baseline's lower bound; baseline 3/30 VM boots (10.0%, #4081); target 2.78% (the baseline's one-sided 95% lower bound); 95% one-sided, exact binomial; pass = 0 leaps in n = 107 boots";
		expect(parseWindow(inflated)).toMatchObject({
			method: "fisher",
			stated: "107",
			computed: "50",
			holds: false,
		});
	});

	it("reads the confidence the basis states", () => {
		expect(
			parseWindow(CONDITIONAL_5346.replace("80% one-sided", "95% one-sided")),
		).toMatchObject({ holds: false });
	});

	it.each([
		["no method", BINOMIAL_EXAMPLE.replace("exact binomial", "a sound test")],
		["no one-sided confidence", FISHER_4093.replace("95% one-sided, ", "")],
		["a pass above zero events", FISHER_4093.replace("pass = 0", "pass = 1")],
		[
			"a pass in another unit than the baseline's",
			CONDITIONAL_DAYS.replace("n = 9.64 days", "n = 231 hours"),
		],
		["a zero-event baseline", FISHER_4093.replace("3/30", "0/30")],
		[
			"no baseline k/N",
			"95% one-sided, Fisher; pass = 0 leaps in n = 50 boots",
		],
	])("leaves alone a basis with %s", (_name, basis) => {
		expect(parseWindow(basis)).toBeNull();
	});
});
