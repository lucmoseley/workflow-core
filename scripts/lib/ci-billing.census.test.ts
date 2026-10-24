// @vitest-environment node
/*
 * The census the CI-cost figures were actually read off, pinned.
 *
 * Every fixture in ci-billing.test.ts was invented, so the whole set stays
 * green through a change that silently alters what the tool reports (mantahostels#675).
 *
 * The fixture here is a slice of the raw responses measure-ci-billing.js cached
 * over 14-18 August 2026 at `--branch all --exclude-event pull_request`,
 * trimmed to the fields the sums read. `commitLog` is that window's real
 * `git log` output, which is where commits-per-push and the docs-only share
 * come from — stored one line per element, because as one string it was a
 * 44,565-character line that `grep … | head` returns whole (#1026).
 *
 * It only catches what this window's data can distinguish: the window holds no
 * skipped and no unfinished job, so the rules covering those are pinned by
 * ci-billing.test.ts alone.
 *
 * Loosen a case and measure-ci-billing.js can drift from the figures the CI
 * trigger and cadence decisions were taken on, so a session re-running it —
 * as scheduled-checks.yml's header says to, to verify a trigger — reads a
 * wrong billed-minutes or push-share figure as a real change. Nothing gates on
 * the script; this test fails CI when red.
 *
 * A FAILURE HERE IS NOT A TEST TO ADJUST. If a change moves one of these
 * numbers, either the change is wrong or the recorded census is — find out
 * which before touching the expectation.
 */

import { describe, expect, it } from "vitest";

const {
	filterRuns,
	summarise,
	parseCommitLog,
	foldPushes,
	pushCommitStats,
} = require("./ci-billing.js");

const fixture = require("../fixtures/ci-census-2026-08-14-18.json");

/** The pipeline measure-ci-billing.js's main() runs, on the fixture's data. */
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
	/* The window's first push carries commits made before it opened, which the
	 * log does not reach, so main() drops it as a floor rather than a count. */
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
