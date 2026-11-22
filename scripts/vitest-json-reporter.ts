import { JsonReporter } from "vitest/reporters";

export default class DurationJsonReporter extends JsonReporter {
	private durations = new Map<string, number>();

	override async onTestRunEnd(
		testModules: Parameters<JsonReporter["onTestRunEnd"]>[0],
	) {
		this.durations = new Map();
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
