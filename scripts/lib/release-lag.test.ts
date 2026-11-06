// @vitest-environment node
/*
 * lib/release-lag.js (#4448): the pin labels and the lag verdict. Loosened,
 * a lag past the threshold reads WITHIN, or an unread lag gives no way out.
 */
import { describe, expect, it } from "vitest";
import {
	formatAdopters,
	judgeLag,
	LAG_WARN_DAYS,
	labelPin,
} from "./release-lag.js";

const isTag = (ref: string | null) => ref !== null && /^v\d/.test(ref);
const SOURCE = "d75011fca2a3c2b3108d067bc19fad17a3ab5b77";
const measured = (days: number) =>
	({ kind: "measured", source: SOURCE, commits: 42, days }) as const;

describe("labelPin", () => {
	it.each([
		[{ ref: "v2.0.1", source: { source: "github" } }, "v2.0.1"],
		[{ ref: null, source: { source: "directory" } }, "directory"],
		[{ ref: "main", source: { source: "github" } }, "untagged ref main"],
		[{ ref: null, source: null }, "no pin"],
	])("labels %j as %s", (pin, label) => {
		expect(labelPin(pin, isTag)).toBe(label);
	});
});

describe("formatAdopters", () => {
	it("counts each label, in version order", () => {
		expect(formatAdopters(["v2.0.10", "v2.0.9", "v2.0.10"])).toBe(
			"Adopters per tag: v2.0.9 ×1, v2.0.10 ×2.",
		);
	});

	it("says so where there is no adopter", () => {
		expect(formatAdopters([])).toBe(
			"Adopters per tag: no adopter checkout found.",
		);
	});
});

describe("judgeLag", () => {
	it("is WITHIN at the threshold, naming commits, days and the short source", () => {
		const v = judgeLag("v2.0.1", measured(LAG_WARN_DAYS), "A.");
		expect(v.state).toBe("WITHIN");
		expect(v.line).toBe(
			`v2.0.1 (from d75011fca) is 42 commit(s) and ${LAG_WARN_DAYS} day(s) behind origin/main. A.`,
		);
	});

	it("is BEHIND past the threshold, naming the release command", () => {
		const v = judgeLag("v2.0.1", measured(LAG_WARN_DAYS + 1), "A.");
		expect(v.state).toBe("BEHIND");
		expect(v.line).toContain(`Past the ${LAG_WARN_DAYS}-day threshold`);
		expect(v.line).toContain("node scripts/release-plugin.js");
	});

	it("is UNREAD on a source this clone lacks, naming the fetch", () => {
		const v = judgeLag(
			"v2.0.1",
			{ kind: "source-absent", source: SOURCE },
			"A.",
		);
		expect(v.state).toBe("UNREAD");
		expect(v.line).toContain("d75011fca is not in this clone");
		expect(v.line).toContain("`git fetch origin`");
	});

	it("is UNREAD on a tag naming no source, saying the next cut is read", () => {
		const v = judgeLag("v2.0.1", { kind: "no-source" }, "A.");
		expect(v.state).toBe("UNREAD");
		expect(v.line).toContain("names no rendered-from source");
		expect(v.line).toContain("the next release it cuts is read");
	});
});
