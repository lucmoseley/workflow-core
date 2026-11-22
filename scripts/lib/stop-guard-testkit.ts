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
	message?: string;
	transcript?: string;
	job?: boolean | string;
	config?: string;
	env?: NodeJS.ProcessEnv;
	payload?: Record<string, unknown>;
	stdin?: string;
	worktree?: string;
}

// #3383 measured under 0.3 s per case, 12 s or more for the quadratic forms at 40,000 characters
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
	worktree,
}: StopRun): { env: NodeJS.ProcessEnv; stdin: string } {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		CLAUDE_CONFIG_DIR: config,
		CLAUDE_PROJECT_DIR: worktree ?? dir,
		WFC_REPO_ROOT: dir,
	};
	if (job) env.CLAUDE_JOB_DIR = job === true ? path.join(dir, "job") : job;
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
				...(worktree === undefined ? {} : { cwd: worktree }),
				...payload,
			}),
	};
}

function parseBlock(status: number | null, stdout: string): StopBlock | null {
	expect(status).toBe(0);
	return stdout.trim() ? JSON.parse(stdout) : null;
}

export function readStopGuardBlock(
	guard: string,
	run: StopRun,
): StopBlock | null {
	const { env, stdin } = stopGuardInput(run);
	const out = runInProcess(guard, [], {
		stdin,
		cwd: run.worktree ?? run.dir,
		env,
	});
	return parseBlock(out.status, out.stdout);
}

export function readStopGuardBlockWithin(
	guard: string,
	run: StopRun,
): StopBlock | null {
	const { env, stdin } = stopGuardInput(run);
	const out = spawnSync(process.execPath, [guard], {
		input: stdin,
		cwd: run.worktree ?? run.dir,
		env,
		encoding: "utf8",
		timeout: HANG_TIMEOUT_MS,
	});
	expect(out.signal, "the guard ran past HANG_TIMEOUT_MS").toBeNull();
	return parseBlock(out.status, out.stdout);
}

export function readStopGuardReason(guard: string, run: StopRun): string {
	const block = readStopGuardBlock(guard, run);
	if (!block) return "";
	expect(block.decision).toBe("block");
	return block.reason;
}
