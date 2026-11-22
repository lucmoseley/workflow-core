import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { runInProcess } from "./run-in-process";

export interface GuardSpawn {
	project: string;
	config: string;
	cwd?: string;
	args?: string[];
	env?: NodeJS.ProcessEnv;
	stdin?: string;
	timeout?: number;
}

export interface GuardRun extends GuardSpawn {
	stderr?: RegExp;
}

export const buildBashPayload = (
	command: string,
	session: string | null = `s-${Math.random()}`,
) => ({
	...(session === null ? {} : { session_id: session }),
	tool_name: "Bash",
	tool_input: { command },
});

export function guardDirs(prefix: string): { dir: string; config: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const config = path.join(dir, "config");
	fs.mkdirSync(config);
	return { dir, config };
}

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

export function guardOutput(guard: string, payload: unknown, run: GuardRun) {
	const r = spawnGuard(guard, payload, run);
	expect(r.status).toBe(0);
	if (run.stderr) expect(r.stderr ?? "").toMatch(run.stderr);
	else expect(r.stderr ?? "").toBe("");
	const out = (r.stdout ?? "").trim();
	return out ? JSON.parse(out).hookSpecificOutput : null;
}

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

const CHECKOUT = path.resolve(__dirname, "..", "..");

const HOOKS_FILES = {
	"hooks/hooks.json": path.join(CHECKOUT, "hooks", "hooks.json"),
	"self-plugin/hooks/hooks.json": path.join(
		CHECKOUT,
		"self-plugin",
		"hooks",
		"hooks.json",
	),
};

const DISPATCH = path.join(CHECKOUT, "scripts", "guard-dispatch.js");

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

export function expectShellHooks(
	script: string,
	want: (file: string) => Record<string, unknown>,
	count = 1,
) {
	for (const [file, at] of Object.entries(HOOKS_FILES)) {
		const entries = Object.values(
			JSON.parse(fs.readFileSync(at, "utf8")).hooks as Record<
				string,
				{ hooks: Record<string, unknown>[] }[]
			>,
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

export function readHookLines(
	hooksFile: keyof typeof HOOKS_FILES,
	script: string,
): string[] {
	const hooks = JSON.parse(fs.readFileSync(HOOKS_FILES[hooksFile], "utf8"))
		.hooks as Record<string, { hooks: { command?: string }[] }[]>;
	return Object.values(hooks)
		.flat()
		.flatMap((group) => group.hooks)
		.map((h) => h.command ?? "")
		.filter((c) => c.includes(script));
}
