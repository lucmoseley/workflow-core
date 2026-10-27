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
import { runInProcess } from "./run-in-process";

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

/**
 * A Node guard entry's run on `payload`, in this process through
 * lib/run-in-process.js (base §X3), with spawnGuard's environment. No
 * `timeout`: a case crossing the clock keeps the spawn.
 */
export function runNodeGuard(
	guard: string,
	payload: unknown,
	{ project, config, cwd, args = [], env = {}, stdin }: GuardSpawn,
) {
	return runInProcess(guard, args, {
		cwd,
		stdin: stdin ?? JSON.stringify(payload),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: project,
			CLAUDE_CONFIG_DIR: config,
			...env,
		},
	});
}

/** guardOutput for a Node guard entry, run through runNodeGuard. */
export function nodeGuardOutput(
	guard: string,
	payload: unknown,
	run: GuardRun,
) {
	const r = runNodeGuard(guard, payload, run);
	expect(r.status).toBe(0);
	if (run.stderr) expect(r.stderr).toMatch(run.stderr);
	else expect(r.stderr).toBe("");
	const out = r.stdout.trim();
	return out ? JSON.parse(out).hookSpecificOutput : null;
}

/** The checkout's root: the plugin root a hook line is run against. */
const CHECKOUT = path.resolve(__dirname, "..", "..");

/** The dispatcher entry every always-on PreToolUse guard runs in (#2786). */
const DISPATCH = path.join(CHECKOUT, "scripts", "guard-dispatch.js");

/**
 * The dispatcher's run of its PreToolUse core `core` alone (`--only`) on
 * `payload`, through runNodeGuard: a core's boundary cases, the real entry,
 * adapters and store, with no other core's context in the answer (#3224).
 */
export function runDispatchCore(
	core: string,
	payload: Record<string, unknown> | null,
	run: GuardSpawn,
) {
	return runNodeGuard(
		DISPATCH,
		payload && { hook_event_name: "PreToolUse", ...payload },
		{ ...run, args: ["--only", core] },
	);
}

/** nodeGuardOutput for runDispatchCore. */
export function dispatchCoreOutput(
	core: string,
	payload: Record<string, unknown>,
	run: GuardRun,
) {
	return nodeGuardOutput(
		DISPATCH,
		{ hook_event_name: "PreToolUse", ...payload },
		{ ...run, args: ["--only", core] },
	);
}

/**
 * The hookSpecificOutput of the registered hook `line`, run by bash as the
 * harness runs it, on a Bash call of `command`; `payload` lays further fields
 * over that call.
 */
export function hookLineOutput(
	line: string,
	command: string,
	{
		payload = {},
		env = {},
		...run
	}: GuardRun & { payload?: Record<string, unknown> },
) {
	return guardOutput(
		"/bin/bash",
		{ ...buildBashPayload(command, "s1"), ...payload },
		{
			...run,
			args: ["-c", line],
			env: { CLAUDE_PLUGIN_ROOT: CHECKOUT, ...env },
		},
	);
}

/**
 * `script` is registered `count` times in the plugin's hooks file and as many
 * in the self-plugin's, each entry matching `want(file)`, and in shell form,
 * so the harness runs it through a shell (mantahostels#2059).
 */
export function expectShellHooks(
	script: string,
	want: (file: string) => Record<string, unknown>,
	count = 1,
) {
	for (const file of ["hooks/hooks.json", "self-plugin/hooks/hooks.json"]) {
		const entries = Object.values(
			JSON.parse(fs.readFileSync(path.join(CHECKOUT, file), "utf8"))
				.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>,
		)
			.flat()
			.flatMap((group) => group.hooks)
			.filter((hook) => String(hook.command).includes(script));
		expect(entries).toHaveLength(count);
		for (const hook of entries) {
			expect(hook).toMatchObject(want(file));
			expect(hook).not.toHaveProperty("args");
		}
	}
}

/**
 * Every command line `hooksFile` registers that runs `script`, in file order —
 * a guard's own registrations, for a test that runs the line the harness
 * runs rather than the script alone.
 */
export function readHookLines(hooksFile: string, script: string): string[] {
	const file = path.join(CHECKOUT, hooksFile);
	const hooks = JSON.parse(fs.readFileSync(file, "utf8")).hooks as Record<
		string,
		{ hooks: { command?: string }[] }[]
	>;
	return Object.values(hooks)
		.flat()
		.flatMap((group) => group.hooks)
		.map((h) => h.command ?? "")
		.filter((c) => c.includes(script));
}

/**
 * A copy of the entry `script` (as `scripts/<name>.js`) under `dir`, its
 * `./lib/` requires pointed at the real libs but for `core`, which is a stub
 * holding the real core's exports but for a `decide` throwing "broke". Returns the copy's path, for a case on the
 * entry's refuse-on-throw exit. No directory is listed, so the read graph
 * charges no lib to the tests importing this kit.
 */
export function entryBesideThrowingCore(
	dir: string,
	script: string,
	core: string,
): string {
	const lib = path.resolve(__dirname);
	const at = path.join(dir, "broken", "scripts");
	fs.mkdirSync(at, { recursive: true });
	const stub = path.join(at, core);
	fs.writeFileSync(
		stub,
		`module.exports = { ...require(${JSON.stringify(path.join(lib, core))}), decide() { throw new Error("broke"); } };\n`,
	);
	const entry = path.join(at, path.basename(script));
	const source = fs.readFileSync(path.join(lib, "..", "..", script), "utf8");
	fs.writeFileSync(
		entry,
		source.replace(
			/require\("\.\/lib\/([^"]+)"\)/g,
			(_, f: string) =>
				`require(${JSON.stringify(f === core ? stub : path.join(lib, f))})`,
		),
		{ mode: 0o755 },
	);
	return entry;
}
