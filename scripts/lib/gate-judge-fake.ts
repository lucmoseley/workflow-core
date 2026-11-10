/*
 * The fake `claude` the gate judge's suites launch (#4964): a Node program
 * that answers `auth status` (lib/auth-status-fake.ts), refuses a flag the
 * recorded harness lacks (lib/headless-argv-fake.js), logs the call, then
 * prints the recorded `result` row (scripts/fixtures/gate-judge-reply.json,
 * re-recorded by `node scripts/record-gate-judge-reply.js`) carrying the
 * canned reading, or fails as told. lib/gate-judge.contract.test.ts holds its
 * row to the recording.
 *
 * Beside lib/headless-run-fake.ts, not in it: that fake's run holds a session
 * open and logs no stdin or working directory; this one answers once with a
 * reading or one of the judge's four failures.
 */

import fs from "node:fs";
import path from "node:path";
import { buildAuthStatusNodeBranch } from "./auth-status-fake";
import { recorded as headless } from "./headless-run-fake";
import { readJsonl } from "./jsonl.js";

export const recorded: {
	harness: string;
	body: string;
	result: Record<string, unknown>;
	observed: Record<string, unknown>;
} = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "gate-judge-reply.json"),
		"utf8",
	),
);

/** The row the fake prints for `reading`. */
export const buildReplyRow = (reading: unknown) => ({
	...recorded.result,
	result: JSON.stringify(reading),
	structured_output: reading,
});

/**
 * What the fake does once launched: print a reading, print `stdout` as it
 * stands, exit non-zero, or hang until killed.
 */
export type JudgeFakePlan =
	| { reading: unknown }
	| { stdout: string }
	| { exit: number }
	| { hang: true };

export interface JudgeCall {
	argv: string[];
	stdin: string;
	cwd: string;
	cwdEntries: string[];
	configDir: string | null;
}

/** Write the fake at `file`, logging each launch to `log`. */
export function writeJudgeFake(file: string, log: string, plan: JudgeFakePlan) {
	let stdout = "";
	if ("reading" in plan) stdout = JSON.stringify(buildReplyRow(plan.reading));
	else if ("stdout" in plan) stdout = plan.stdout;
	const program = `#!/usr/bin/env node
${buildAuthStatusNodeBranch()}
const fs = require("node:fs");
const { parseArgv } = require(${JSON.stringify(path.join(__dirname, "headless-argv-fake.js"))});
const read = parseArgv(${JSON.stringify(headless.options)}, process.argv.slice(2));
if ("error" in read) {
	process.stderr.write(read.error + "\\n");
	process.exit(1);
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
	argv: process.argv.slice(2),
	stdin: fs.readFileSync(0, "utf8"),
	cwd: process.cwd(),
	cwdEntries: fs.readdirSync(process.cwd()),
	configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
}) + "\\n");
if (${"hang" in plan}) setInterval(() => {}, 1000);
else {
	process.stdout.write(${JSON.stringify(stdout)});
	process.exitCode = ${"exit" in plan ? plan.exit : 0};
}
`;
	fs.writeFileSync(file, program, { mode: 0o755 });
	return file;
}

/** Every launch the fake logged to `log`, in order. */
export const readJudgeCalls = (log: string) =>
	(readJsonl(log)?.rows ?? []) as unknown as JudgeCall[];
