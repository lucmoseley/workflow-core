import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reportFile } = require("./notify-report.js");

export function runRecordFile(checker: string): string {
	const report: string = reportFile(checker);
	if (!report.endsWith(".report.json"))
		throw new Error(`${report} no longer ends .report.json`);
	return `${report.slice(0, -".report.json".length)}.run.json`;
}
