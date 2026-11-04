/*
 * vitest-json-reporter.ts — vitest's JSON report with each file's `duration`
 * added, hooks included, as the default reporter prints it (#4313). The JSON
 * reporter's own endTime - startTime sums only the tests, leaving beforeAll
 * and afterAll out.
 *
 * IMPLICIT:  where ci.yml names WFC_VITEST_JSON, writes vitest's JSON report there with each file's `duration` added, which `scripts/lib/suite-timings.js` reads.
 * JUSTIFIED: convenience — the report is what the per-file CI record and `check-file-ci-time.js` are read from.
 * DEFEAT:    unset WFC_VITEST_JSON, and no report is written.
 */

import { JsonReporter } from "vitest/reporters";

export default class DurationJsonReporter extends JsonReporter {
	private durations = new Map<string, number>();

	override async onTestRunEnd(
		testModules: Parameters<JsonReporter["onTestRunEnd"]>[0],
	) {
		this.durations = new Map();
		// diagnostic() reads a module with no result as 0; one that ran is
		// timed in fractional ms, never exactly 0.
		for (const m of testModules) {
			const { duration } = m.diagnostic();
			if (duration > 0) this.durations.set(m.moduleId, duration);
		}
		await super.onTestRunEnd(testModules);
	}

	override async writeReport(report: string) {
		const parsed = JSON.parse(report) as {
			testResults?: { name: string; duration?: number }[];
		};
		for (const r of parsed.testResults ?? []) {
			const duration = this.durations.get(r.name);
			if (duration !== undefined) r.duration = duration;
		}
		await super.writeReport(JSON.stringify(parsed));
	}
}
