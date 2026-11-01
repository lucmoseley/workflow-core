/*
 * A session start for a script under test (#3707, #3772): its environment, an
 * interactive one or a background job's where `jobDir` names one, with every
 * variable lib/background-start.js reads set, so a suite run inside a
 * background job tests the same start as one run in a terminal or CI; and the
 * job's record that module reads.
 */

import fs from "node:fs";
import path from "node:path";

export const startEnv = (jobDir = "") => ({
	CLAUDE_JOB_DIR: jobDir,
	CLAUDE_CODE_ENTRYPOINT: "cli",
});

/** Writes `jobDir`'s record as the harness does; returns `jobDir`. */
export const writeJobRecord = (jobDir: string, template: string) => {
	fs.mkdirSync(jobDir, { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "state.json"),
		JSON.stringify({ template }),
	);
	return jobDir;
};
