/*
 * guard-core-testkit.ts — one dispatcher core run in process, as the entry
 * runs it, over the production adapters (#2789, #2787): its row from
 * lib/guard-cores.json, its host ports, the real rule store and the latch
 * directory under the case's root.
 *
 * The hook's own directory and environment are the case's, never the test
 * process's: `cwd` stands in for the hook's cwd, `env` for both the shell
 * variables a command expands through and the environment a core reads.
 */

import {
	dispatch,
	hostAdapters,
	loadCores,
	type Output,
} from "./guard-dispatch.js";
import { writeLatches } from "./guard-entry.js";
import { readHookPersistChars } from "./rule-emission.js";

/**
 * The payload of a `tool` call carrying `input`, as the harness sends it;
 * `top` is laid over its own fields, a `session_id` of undefined leaving the
 * session out.
 */
export const toolCall = (
	tool: string,
	input: Record<string, unknown>,
	top: Record<string, unknown> = {},
): Record<string, unknown> => ({
	session_id: "s1",
	tool_name: tool,
	tool_input: input,
	...top,
});

export interface CoreRun {
	/** Null where silent. */
	output: Output | null;
	logs: string[];
}

/**
 * Run the `event` core `name` on `payload` with `root` as the host root.
 * `env` is the whole environment: nothing of the test process's leaks in.
 */
export function runCore(
	name: string,
	payload: Record<string, unknown>,
	{
		root,
		cwd = root,
		env = {},
		event = "PreToolUse",
	}: {
		root: string;
		cwd?: string;
		env?: Record<string, string>;
		event?: "PreToolUse" | "PostToolUse";
	},
): CoreRun {
	const logs: string[] = [];
	const log = (what: string) => {
		logs.push(what);
	};
	const cores = loadCores(event).filter((c) => c.name === name);
	if (cores.length !== 1) throw new Error(`no ${event} core named ${name}`);
	const { output, latches } = dispatch(cores, {
		payload,
		root,
		adapters: {
			...hostAdapters(root, log),
			fallbackCwd: cwd,
			vars: env,
			env,
		},
		logFor: () => log,
		disabled: () => false,
		persistChars: readHookPersistChars,
	});
	for (const l of latches) writeLatches({ root, payload, log }, l.latches);
	return { output, logs };
}
