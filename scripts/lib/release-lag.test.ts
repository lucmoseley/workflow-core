// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	formatAdopters,
	judgeInstalls,
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

const adopter = (name: string, pin: string, installed: string | null) => ({
	name,
	pin,
	installed,
});

describe("formatAdopters", () => {
	it("states each adopter's pin beside its install, by name", () => {
		expect(
			formatAdopters([
				adopter("b", "v2.0.10", "2.0.9"),
				adopter("a", "no pin", null),
			]),
		).toBe(
			"Adopters, pin / installed: a no pin / not installed, b v2.0.10 / v2.0.9.",
		);
	});

	it("says so where there is no adopter", () => {
		expect(formatAdopters([])).toBe("Adopters: no adopter checkout found.");
	});
});

describe("judgeInstalls", () => {
	it("names only the adopters whose install is off the pin, pin beside install", () => {
		expect(
			judgeInstalls([
				adopter("level", "v2.3.0", "2.3.0"),
				adopter("old", "v2.3.0", "2.1.0"),
			]),
		).toEqual({
			finding: "INSTALL-OFF-PIN",
			line: expect.stringMatching(
				/^Install not at pin, pin \/ installed: old v2\.3\.0 \/ v2\.1\.0\. /,
			),
		});
	});

	it.each([
		["v2.0.10", "2.0.9", true],
		["v2.3.0", null, true],
		["v2.3.0", "2.3.0", false],
		["v2.3.0", "2.4.0", true],
		["v2.3.0", "d75011fca2a3", true],
		["2.3.0-rc.1", "2.3.0-rc.1", false],
		["untagged ref main", "2.0.1", false],
		["no pin", null, false],
	])("pin %s, installed %s: off the pin %s", (pin, installed, off) => {
		expect(judgeInstalls([adopter("a", pin, installed)]) !== null).toBe(off);
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
	sourceOf: () => /rendered from ([0-9a-f]{40})/.exec(message)?.[1] ?? null,
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
