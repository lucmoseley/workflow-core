/*
 * notify-report-testkit.ts — where `notify-report.js` keeps a checker's open
 * run record, for a test that doctors or removes one (#1367).
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reportFile } = require("./notify-report.js");

/** The open run record's path for `checker`. Throws where the report path no
 * longer ends `.report.json`, rather than handing back the report itself. */
export function runRecordFile(checker: string): string {
	const report: string = reportFile(checker);
	if (!report.endsWith(".report.json"))
		throw new Error(`${report} no longer ends .report.json`);
	return `${report.slice(0, -".report.json".length)}.run.json`;
}
