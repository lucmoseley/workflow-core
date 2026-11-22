// @vitest-environment node

import { describe, expect, it } from "vitest";

const {
	filterRuns,
	summarise,
	parseCommitLog,
	foldPushes,
	pushCommitStats,
} = require("./ci-billing.js");

const fixture = require("../fixtures/ci-census-2026-08-14-18.json");

const census = () => {
	const scoped = filterRuns(fixture.runs, fixture.window.excludeEvents);
	const summary = summarise(
		scoped,
		(run: { id: string }) => fixture.jobs[run.id] || [],
	);
	const pushShas = [
		...new Set(
			scoped
				.filter((r: { event: string }) => r.event === "push")
				.map((r: { head_sha: string }) => r.head_sha)
				.filter(Boolean),
		),
	];
	const folded = foldPushes(
		parseCommitLog(fixture.commitLog.join("\n")),
		pushShas,
	);
	return { summary, pushCommits: pushCommitStats(folded.pushes.slice(1)) };
};

describe("the recorded 14-18 August 2026 census", () => {
	it("still starts from the responses it was measured on", () => {
		expect(fixture.runs).toHaveLength(366);
		expect(Object.keys(fixture.jobs)).toHaveLength(357);
	});

	it("drops exactly the pull_request runs the reproducing scope excludes", () => {
		expect(filterRuns(fixture.runs, fixture.window.excludeEvents)).toHaveLength(
			357,
		);
	});

	it("reproduces the runs, jobs and billed minutes", () => {
		const { summary } = census();
		expect(summary.runs).toBe(357);
		expect(summary.jobs).toBe(550);
		expect(summary.billed).toBe(834);
	});

	it("reproduces the billed:actual ratio — what rounding up to the minute costs", () => {
		expect(census().summary.ratio.toFixed(2)).toBe("1.55");
	});

	it("reproduces the per-job billed split", () => {
		const byJob = new Map<string, number>(
			census().summary.perJob.map((j: { job: string; pct: number }) => [
				j.job,
				j.pct,
			]),
		);
		expect(byJob.get("Lint and tests")?.toFixed(1)).toBe("55.5");
		expect(byJob.get("Python")?.toFixed(1)).toBe("23.0");
		expect(byJob.get("Document guards")?.toFixed(1)).toBe("20.3");
	});

	it("reproduces commits per push, and the two shares read off it", () => {
		const { pushCommits } = census();
		expect(pushCommits.mean.toFixed(2)).toBe("2.08");
		expect(pushCommits.singleCommitShare.toFixed(0)).toBe("50");
		expect(pushCommits.docsOnlyShare.toFixed(1)).toBe("47.8");
	});
});
