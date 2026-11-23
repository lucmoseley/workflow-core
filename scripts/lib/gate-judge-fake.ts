import fs from "node:fs";
import path from "node:path";
import { buildAuthStatusNodeBranch } from "./auth-status-fake";
import { recorded as headless } from "./headless-run-fake";
import { hostRoot } from "./host-root.js";
import { overrideFingerprint } from "./issue-gate.js";
import { readJsonl } from "./jsonl.js";
import { markersDir } from "./marker-root.js";

export const MODEL_LEAD = "faults the model reading of this body raises";
export const OVERRIDE_LEAD = "Gate judge override honoured";
export const OVERRIDE_REASON = "the records build up on demand";
export const OVERRIDE_LINE = `**Gate judge override:** ${OVERRIDE_REASON}`;
export const REVIEWED_LINE = `**Gate judge override reviewed:** ${overrideFingerprint(OVERRIDE_REASON)} — 2026-11-23 — #251`;
export const FALLBACK_LEAD = "The model reading of this body did not run";

// guess, #5156
export const LAUNCHED_BOUND_MS = 60_000;

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

export const buildReplyRow = (reading: unknown) => ({
	...recorded.result,
	result: JSON.stringify(reading),
	structured_output: reading,
});

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

function planStdout(plan: JudgeFakePlan) {
	if ("reading" in plan) return JSON.stringify(buildReplyRow(plan.reading));
	return "stdout" in plan ? plan.stdout : "";
}

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

export const readJudgeCalls = (log: string) =>
	(readJsonl(log)?.rows ?? []) as unknown as JudgeCall[];

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
