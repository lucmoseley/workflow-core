/*
 * pretool-guard-testkit.ts — spawn a PreToolUse guard on a harness-shaped
 * payload and read back what it handed the session (#2143), so a change to the
 * payload shape or the env isolation lands once instead of in every guard test.
 *
 * NEVER point `config` at a real config dir: a fail-open is written under
 * CLAUDE_CONFIG_DIR (mantahostels#147). The latch lands under CLAUDE_PROJECT_DIR,
 * so `project` is a temp dir or a fixture repo, never the checkout.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";

export interface GuardSpawn {
	/** Exported as CLAUDE_PROJECT_DIR. */
	project: string;
	/** Exported as CLAUDE_CONFIG_DIR. */
	config: string;
	/** Where the guard is spawned; left off, the test process's own. */
	cwd?: string;
	/** The guard's arguments, as its registration's command passes them. */
	args?: string[];
	/** Laid over the env last; an `undefined` value unsets. */
	env?: NodeJS.ProcessEnv;
	/** Sent in place of the payload, for a malformed one. */
	stdin?: string;
	/** Kills the guard past this many ms, which then throws as not run. */
	timeout?: number;
}

export interface GuardRun extends GuardSpawn {
	/** What stderr must match; left off, it must be empty. */
	stderr?: RegExp;
}

/**
 * The payload Claude Code sends a PreToolUse hook on a Bash call. A null
 * session leaves `session_id` off, for a guard's no-session fail-open.
 */
export const buildBashPayload = (
	command: string,
	session: string | null = `s-${Math.random()}`,
) => ({
	...(session === null ? {} : { session_id: session }),
	tool_name: "Bash",
	tool_input: { command },
});

/** A temp project dir with an empty config dir inside it; the caller removes `dir`. */
export function guardDirs(prefix: string): { dir: string; config: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const config = path.join(dir, "config");
	fs.mkdirSync(config);
	return { dir, config };
}

/** The guard's raw run on `payload`. Throws where it did not run at all. */
export function spawnGuard(
	guard: string,
	payload: unknown,
	{ project, config, cwd, args = [], env = {}, stdin, timeout }: GuardSpawn,
): SpawnSyncReturns<string> {
	const r = spawnSync(guard, args, {
		cwd,
		encoding: "utf8",
		input: stdin ?? JSON.stringify(payload),
		timeout,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: project,
			CLAUDE_CONFIG_DIR: config,
			...env,
		},
	});
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	return r;
}

/**
 * The guard's `hookSpecificOutput` on `payload`, or null where it said nothing.
 *
 * A guard that CRASHED also emits no verdict, so the exit status and stderr
 * are asserted on every call. Left as JSON.parse types it, as the
 * guard tests read whichever envelope field their guard prints.
 */
export function guardOutput(guard: string, payload: unknown, run: GuardRun) {
	const r = spawnGuard(guard, payload, run);
	expect(r.status).toBe(0);
	if (run.stderr) expect(r.stderr ?? "").toMatch(run.stderr);
	else expect(r.stderr ?? "").toBe("");
	const out = (r.stdout ?? "").trim();
	return out ? JSON.parse(out).hookSpecificOutput : null;
}
