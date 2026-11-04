/*
 * The in-process run of report-new-shared-faults.js, shared by its two test
 * files (#4305) so both drive the program with the same checker-table redirect.
 */

import path from "node:path";
import { runInProcess } from "./run-in-process";

export const SCRIPT = path.join(__dirname, "..", "report-new-shared-faults.js");
export const CHECKERS_ENV = "WFC_SHARED_FAULT_CHECKERS";

export const lines = (s: string) => (s ? s.replace(/\n$/, "").split("\n") : []);

/** One run on `ref`, its checker table replaced by `checkers`. */
export function run(
	ref: string,
	{ checkers, cwd }: { checkers: Record<string, string>; cwd: string },
) {
	const r = runInProcess(SCRIPT, [ref], {
		cwd,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: cwd,
			[CHECKERS_ENV]: JSON.stringify(checkers),
		},
	});
	return { code: r.status, out: lines(r.stdout), err: lines(r.stderr) };
}
