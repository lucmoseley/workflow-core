// @vitest-environment node
/*
 * lib/release-lag.js (#4448): the pin labels, the lag reading and its
 * verdict. In-process over a fake git port and literal readings; the
 * program's test crosses real git. Loosened, a lag past the threshold reads
 * WITHIN, or an unread lag gives no way out.
 */
import { describe, expect, it } from "vitest";
import {
	formatAdopters,
	judgeLag,
	LAG_WARN_DAYS,
	labelPin,
	readLag,
} from "./release-lag.js";

const DAY = 86_400;
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
		expect(labelPin(pin)).toBe(label);
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

const port = ({
	message = `Release workflow-core v2.0.1, rendered from ${SOURCE}`,
	known = true,
	tipAt = 3 * DAY,
}: {
	message?: string;
	known?: boolean;
	tipAt?: number;
} = {}) => ({
	message: () => message,
	hasCommit: () => known,
	count: (range: string) => (range === `${SOURCE}..tip` ? 42 : -1),
	time: (rev: string) => (rev === "tip" ? tipAt : 0),
});

describe("readLag", () => {
	it("measures commits and whole days from the tag's source to the tip", () => {
		expect(readLag(port({ tipAt: 3.9 * DAY }), "v2.0.1", "tip")).toEqual({
			kind: "measured",
			source: SOURCE,
			commits: 42,
			days: 3,
		});
	});

	it("reads 0 days where the tip is dated before its source", () => {
		expect(readLag(port({ tipAt: -DAY }), "v2.0.1", "tip")).toMatchObject({
			days: 0,
		});
	});

	it("reads no-source where the message names none", () => {
		expect(
			readLag(port({ message: "Release v2.0.1" }), "v2.0.1", "tip"),
		).toEqual({ kind: "no-source" });
	});

	it("reads source-absent where the clone lacks the source", () => {
		expect(readLag(port({ known: false }), "v2.0.1", "tip")).toEqual({
			kind: "source-absent",
			source: SOURCE,
		});
	});
});

describe("judgeLag", () => {
	it("is WITHIN at the threshold, naming commits, days and the short source", () => {
		const v = judgeLag("v2.0.1", measured(LAG_WARN_DAYS), "A.");
		expect(v).toMatchObject({ state: "WITHIN", finding: null });
		expect(v.line).toBe(
			`v2.0.1 (from d75011fca2a3) is 42 commit(s) and ${LAG_WARN_DAYS} day(s) behind origin/main. A.`,
		);
	});

	it("is BEHIND past the threshold, naming the release command", () => {
		const v = judgeLag("v2.0.1", measured(LAG_WARN_DAYS + 1), "A.");
		expect(v).toMatchObject({ state: "BEHIND", finding: "RELEASE-LAG" });
		expect(v.line).toContain(`Past the ${LAG_WARN_DAYS}-day threshold`);
		expect(v.line).toContain("node scripts/release-plugin.js");
	});

	it("is UNREAD on a source this clone lacks, naming the fetch", () => {
		const v = judgeLag(
			"v2.0.1",
			{ kind: "source-absent", source: SOURCE },
			"A.",
		);
		expect(v).toMatchObject({ state: "UNREAD", finding: "LAG-UNREAD" });
		expect(v.line).toContain("d75011fca2a3 is not in this clone");
		expect(v.line).toContain("`git fetch origin`");
	});

	it("is UNREAD on a tag naming no source, saying the next cut is read", () => {
		const v = judgeLag("v2.0.1", { kind: "no-source" }, "A.");
		expect(v).toMatchObject({ state: "UNREAD", finding: "LAG-UNREAD" });
		expect(v.line).toContain("names no rendered-from source");
		expect(v.line).toContain("the next release it cuts is read");
	});
});
