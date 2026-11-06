// @vitest-environment node
/*
 * repo-checks-carry.test.ts — the clobbers window (#1551) and re-scan list
 * (#1600) one daily repo-checks reading carries to the next. Loosen one and a
 * window skips the days a BROKEN reading never examined, or an unfixed
 * clobber on an issue nobody edits again drops out once the window passes it.
 *
 * Each case folds a run of readings through `carriedArgs` and `carriedNext`
 * as the runner does, in memory. The file round trip and the argv the runner
 * launches with are scripts/repo-checks.test.ts's.
 */

import { describe, expect, it } from "vitest";

const { carriedArgs, carriedNext } = require("./repo-checks-carry.js");
const { REPO_CHECKS } = require("./repo-checks-registry.js");

const CLOBBERS = REPO_CHECKS.find((e: { id: string }) => e.id === "clobbers");

interface Reading {
	at: string;
	/** Absent: the gate SKIPped clobbers, so nothing was launched. */
	outcome?: string;
	keys?: string[];
}

/** The argv clobbers took at each reading it was launched in. */
function fold(readings: Reading[]): string[][] {
	let kept = { lastStarts: {}, rescans: {} };
	const argvs: string[][] = [];
	for (const { at, outcome = "SKIP", keys = [] } of readings) {
		const startMs = Date.parse(at);
		if (outcome !== "SKIP")
			argvs.push(carriedArgs(CLOBBERS, { ...kept, startMs }));
		const next = Object.fromEntries(
			carriedNext([{ job: "clobbers", outcome, keys }], { ...kept, startMs }),
		);
		kept = {
			lastStarts: next.starts ?? kept.lastStarts,
			rescans: next.rescans ?? kept.rescans,
		};
	}
	return argvs;
}
const windows = (readings: Reading[]) =>
	fold(readings).map((argv) => argv[argv.indexOf("--since") + 1]);
const rescans = (readings: Reading[]) =>
	fold(readings).map((argv) =>
		argv.includes("--rescan") ? argv[argv.indexOf("--rescan") + 1] : null,
	);

describe("repo-checks-carry: the clobbers window", () => {
	it("passes the days since the last completed reading's start, rounded up, plus one, a WARN or FAIL counting as completed", () => {
		expect(
			windows([
				{ at: "2026-10-13T06:00:00Z", outcome: "WARN" },
				{ at: "2026-10-14T06:00:00Z", outcome: "WARN" },
				{ at: "2026-10-15T07:00:00Z", outcome: "FAIL" },
				{ at: "2026-10-16T07:00:00Z", outcome: "FAIL" },
			]),
		).toEqual(["30", "2", "3", "2"]);
	});

	it("leaves the window's start where it was through a reading in which clobbers was BROKEN, MISSING or SKIP", () => {
		expect(
			windows([
				{ at: "2026-10-13T06:00:00Z", outcome: "OK" },
				{ at: "2026-10-14T06:00:00Z", outcome: "BROKEN" },
				{ at: "2026-10-15T06:00:00Z", outcome: "MISSING" },
				{ at: "2026-10-16T06:00:00Z" },
				{ at: "2026-10-17T06:00:00Z", outcome: "OK" },
				{ at: "2026-10-18T06:00:00Z", outcome: "OK" },
			]),
		).toEqual(["30", "2", "3", "5", "2"]);
	});
});

describe("repo-checks-carry: the re-scan list", () => {
	const clobberKeys = [
		"CLOBBERED\t#8\t2026-10-01T06:00:00Z",
		"SUSPECT\t#12\t2026-10-02T06:00:00Z",
		"SUSPECT\t#8\t2026-10-03T06:00:00Z",
	];

	it("passes no --rescan on a repo's first reading, then the issues of the last completed reading's CLOBBERED and SUSPECT keys", () => {
		expect(
			rescans([
				{ at: "2026-10-13T06:00:00Z", outcome: "FAIL", keys: clobberKeys },
				{ at: "2026-10-14T06:00:00Z", outcome: "FAIL", keys: clobberKeys },
				{
					at: "2026-10-15T06:00:00Z",
					outcome: "WARN",
					keys: ["SUSPECT\t#3\t2026-10-13T06:00:00Z"],
				},
				{ at: "2026-10-16T06:00:00Z", outcome: "OK" },
				{ at: "2026-10-17T06:00:00Z", outcome: "OK" },
			]),
		).toEqual([null, "8,12", "8,12", "3", null]);
	});

	it("keeps the previous re-scan list through a reading in which clobbers was BROKEN or MISSING", () => {
		expect(
			rescans([
				{ at: "2026-10-13T06:00:00Z", outcome: "FAIL", keys: clobberKeys },
				{ at: "2026-10-14T06:00:00Z", outcome: "BROKEN" },
				{ at: "2026-10-15T06:00:00Z", outcome: "MISSING" },
				{ at: "2026-10-16T06:00:00Z", outcome: "OK" },
			]),
		).toEqual([null, "8,12", "8,12", "8,12"]);
	});

	it("passes only the issue numbers in a damaged re-scan list", () => {
		expect(
			carriedArgs(CLOBBERS, {
				lastStarts: {},
				rescans: { clobbers: ["x", 8, -1, 1.5, 12] },
				startMs: Date.parse("2026-10-13T06:00:00Z"),
			}),
		).toEqual(["--since", "30", "--rescan", "8,12"]);
	});
});
