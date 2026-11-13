/*
 * The fake `claude` the gate judge's suites launch (#4964): a Node program
 * that answers `auth status` (lib/auth-status-fake.ts), refuses a flag the
 * recorded harness lacks (lib/headless-argv-fake.js), logs the call, then
 * prints the recorded `result` row (scripts/fixtures/gate-judge-reply.json,
 * re-recorded by `node scripts/record-gate-judge-reply.js`) carrying the
 * canned reading, or fails as told; and `judgeServe`, the same plan as
 * lib/gate-judge.js's in-process `judge` port. lib/gate-judge.contract.test.ts
 * holds its row to the recording and `judgeServe` to the launched fake.
 *
 * Beside lib/headless-run-fake.ts, not in it: that fake's run holds a session
 * open and logs no stdin or working directory.
 */

import fs from "node:fs";
import path from "node:path";
import { buildAuthStatusNodeBranch } from "./auth-status-fake";
import { recorded as headless } from "./headless-run-fake";
import { hostRoot } from "./host-root.js";
import { readJsonl } from "./jsonl.js";
import { markersDir } from "./marker-root.js";

/* The leads a write route's notes open with, pinned here so a change to
 * them is a change to these suites. */
export const MODEL_LEAD = "faults the model reading of this body raises";
export const OVERRIDE_LEAD = "Gate judge override honoured";
/** An override line the suites write, and its reason. */
export const OVERRIDE_REASON = "the records build up on demand";
export const OVERRIDE_LINE = `**Gate judge override:** ${OVERRIDE_REASON}`;
export const FALLBACK_LEAD = "The model reading of this body did not run";

/* A judge bound far over a launched call, which is three Node starts. */
export const LAUNCHED_BOUND_MS = 60_000;

/** Where lib/gate-judge.js logs each write route's model call. */
export const callLogPath = () =>
	path.join(markersDir(hostRoot()), ".gate-judge-calls.jsonl");

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

/** What the fake prints on `plan`. */
function planStdout(plan: JudgeFakePlan) {
	if ("reading" in plan) return JSON.stringify(buildReplyRow(plan.reading));
	return "stdout" in plan ? plan.stdout : "";
}

/**
 * The in-process `judge` port: the run the launcher hands back once the fake
 * has answered `plan`, each prompt pushed to `prompts`. A hang stays a
 * launched fake's, for the launcher's real kill.
 */
export function judgeServe(
	plan: Exclude<JudgeFakePlan, { hang: true }>,
	prompts: string[] = [],
) {
	return (prompt: string) => {
		prompts.push(prompt);
		return {
			status: "exit" in plan ? plan.exit : 0,
			signal: null,
			stdout: planStdout(plan),
			stderr: "",
		};
	};
}

/** Write the fake at `file`, logging each launch to `log`. */
export function writeJudgeFake(file: string, log: string, plan: JudgeFakePlan) {
	const stdout = planStdout(plan);
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

/**
 * What a write route under test needs to reach the fake through the real
 * launcher: the judge on (the suites' setup turns it off), the fake as the
 * binary, and the config dir a seat. Launches log to `<dir>/judge-calls.jsonl`.
 */
export function judgeFakeEnv(
	dir: string,
	plan: JudgeFakePlan,
	configDir = process.env.CLAUDE_CONFIG_DIR ?? "",
) {
	const log = path.join(dir, "judge-calls.jsonl");
	return {
		log,
		env: {
			WFC_GATE_JUDGE: "",
			WFC_CLAUDE_BIN: writeJudgeFake(path.join(dir, "claude-judge"), log, plan),
			WFC_CLAUDE_CONFIG_A: configDir,
		},
	};
}
