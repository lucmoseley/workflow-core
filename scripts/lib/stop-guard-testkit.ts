/*
 * stop-guard-testkit.ts — drive a Stop guard in process, the way
 * `.claude/settings.json` runs it, with every root it writes under redirected
 * into the test's temp directory (#602); or in a process of its own, for a
 * case held to a time bound.
 *
 * NEVER drop the redirects: without WFC_REPO_ROOT the block counters resolve to
 * the real repo root, where a fixed session id spends the shared allowance and
 * a later case passes vacuously once an earlier one has run three times.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect } from "vitest";
import { runInProcess } from "./run-in-process";

export interface StopBlock {
	decision: string;
	reason: string;
}

export interface StopRun {
	dir: string;
	sid: string;
	/** The turn's text on the payload; left off, the guard reads `transcript`. */
	message?: string;
	transcript?: string;
	/** `true` runs as a background job under `<dir>/job`; a string names the job dir. */
	job?: boolean | string;
	config?: string;
	/** Applied last, so it beats `job` too; an `undefined` value unsets. */
	env?: NodeJS.ProcessEnv;
	/** Further payload keys, spread last — `stop_hook_active`, say. */
	payload?: Record<string, unknown>;
	/** Sent in place of the whole payload, for a malformed one. */
	stdin?: string;
}

/**
 * The bound a guard's read of a long input is held to, run as its own
 * process: a regex match is synchronous, so only a process timeout can stop a
 * backtracking one (#2188, #3383). Measured on this machine, each case under
 * it reads its input in under 0.3 s, and the quadratic forms those cases guard
 * take 12 s or more at 40,000 characters, so over a minute at 100,000;
 * #2188's exponential one never finishes. 10 s sits far above the one and far
 * below the other.
 */
export const HANG_TIMEOUT_MS = 10_000;

function stopGuardInput({
	dir,
	sid,
	message,
	transcript = path.join(dir, "absent.jsonl"),
	job = false,
	config = path.join(dir, "config"),
	env: extra = {},
	payload = {},
	stdin,
}: StopRun): { env: NodeJS.ProcessEnv; stdin: string } {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: config,
		CLAUDE_PROJECT_DIR: dir,
		WFC_REPO_ROOT: dir,
	};
	if (job) env.CLAUDE_JOB_DIR = job === true ? path.join(dir, "job") : job;
	else delete env.CLAUDE_JOB_DIR;
	for (const [k, v] of Object.entries(extra))
		if (v === undefined) delete env[k];
		else env[k] = v;
	return {
		env,
		stdin:
			stdin ??
			JSON.stringify({
				session_id: sid,
				hook_event_name: "Stop",
				...(message === undefined ? {} : { last_assistant_message: message }),
				transcript_path: transcript,
				...payload,
			}),
	};
}

/** The guard's block on its stdout, or null where it allows the stop. */
function parseBlock(status: number | null, stdout: string): StopBlock | null {
	expect(status).toBe(0);
	return stdout.trim() ? JSON.parse(stdout) : null;
}

/** The guard's block, or null where it allows the stop. */
export function readStopGuardBlock(
	guard: string,
	run: StopRun,
): StopBlock | null {
	const { env, stdin } = stopGuardInput(run);
	const out = runInProcess(guard, [], { stdin, cwd: run.dir, env });
	return parseBlock(out.status, out.stdout);
}

/**
 * readStopGuardBlock in a process of its own, killed past HANG_TIMEOUT_MS: for
 * a case that pins a read as prompt.
 */
export function readStopGuardBlockWithin(
	guard: string,
	run: StopRun,
): StopBlock | null {
	const { env, stdin } = stopGuardInput(run);
	const out = spawnSync(process.execPath, [guard], {
		input: stdin,
		cwd: run.dir,
		env,
		encoding: "utf8",
		timeout: HANG_TIMEOUT_MS,
	});
	expect(out.signal, "the guard ran past HANG_TIMEOUT_MS").toBeNull();
	return parseBlock(out.status, out.stdout);
}

/** The refusal the guard writes, or "" where it allows the stop. */
export function readStopGuardReason(guard: string, run: StopRun): string {
	const block = readStopGuardBlock(guard, run);
	if (!block) return "";
	expect(block.decision).toBe("block");
	return block.reason;
}
