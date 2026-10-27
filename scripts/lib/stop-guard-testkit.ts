/*
 * stop-guard-testkit.ts — drive a Stop guard in process, the way
 * `.claude/settings.json` runs it, with every root it writes under redirected
 * into the test's temp directory (#602).
 *
 * NEVER drop the redirects: without WFC_REPO_ROOT the block counters resolve to
 * the real repo root, where a fixed session id spends the shared allowance and
 * a later case passes vacuously once an earlier one has run three times.
 */

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

/** The guard's block, or null where it allows the stop. */
export function readStopGuardBlock(
	guard: string,
	{
		dir,
		sid,
		message,
		transcript = path.join(dir, "absent.jsonl"),
		job = false,
		config = path.join(dir, "config"),
		env: extra = {},
		payload = {},
		stdin,
	}: StopRun,
): StopBlock | null {
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
	const out = runInProcess(guard, [], {
		stdin:
			stdin ??
			JSON.stringify({
				session_id: sid,
				hook_event_name: "Stop",
				...(message === undefined ? {} : { last_assistant_message: message }),
				transcript_path: transcript,
				...payload,
			}),
		cwd: dir,
		env,
	});
	expect(out.status).toBe(0);
	return out.stdout.trim() ? JSON.parse(out.stdout) : null;
}

/** The refusal the guard writes, or "" where it allows the stop. */
export function readStopGuardReason(guard: string, run: StopRun): string {
	const block = readStopGuardBlock(guard, run);
	if (!block) return "";
	expect(block.decision).toBe("block");
	return block.reason;
}
