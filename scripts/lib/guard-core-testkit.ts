/*
 * guard-core-testkit.ts — one dispatcher core run in process, as the entry
 * runs it, over the production adapters (#2789, #2787): its row from
 * lib/guard-cores.json, its host ports, the real rule store and the latch
 * directory under the case's root.
 *
 * The hook's own directory and environment are the case's, never the test
 * process's: `cwd` stands in for the hook's cwd, `env` for both the shell
 * variables a command expands through and the environment a core reads.
 *
 * `worktree` is the split a session in its own worktree runs under (#4229):
 * `CLAUDE_PROJECT_DIR` names the main checkout, the root, while the hook's cwd
 * is a linked worktree of it.
 */

import fs from "node:fs";
import path from "node:path";
import { defineTemplate, trioTemplate } from "./git-fixture";
import { loadCores } from "./guard-core-load.js";
import { dispatch, type Output } from "./guard-dispatch.js";
import { writeLatches } from "./guard-entry.js";
import { hostAdapters } from "./guard-host-ports.js";
import { MARKERS_REL } from "./marker-root.js";
import { readHookPersistChars } from "./rule-emission.js";

/**
 * `event`'s cores, a load fault thrown: the dispatcher would answer it with the
 * row's policy, which reads to a test as that core's own allow or deny (#4125).
 */
export const loadedCores = (event: string) => {
	const cores = loadCores(event);
	for (const c of cores)
		if ("loadFault" in c) throw new Error(`${c.name}: ${c.loadFault}`);
	return cores;
};

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

const split = defineTemplate(trioTemplate({ worktree: "detach" }));

/**
 * A main checkout and a linked worktree of it, cut detached from its `main` as
 * a session's is, built in `dir`: each holds a committed `a.md`. The caller
 * removes `dir`.
 */
export const splitCheckout = (dir: string) => {
	split.instantiate(dir);
	return {
		main: fs.realpathSync(path.join(dir, "shared")),
		worktree: fs.realpathSync(path.join(dir, "wt")),
	};
};

export const writeHostConfig = (root: string, config: object) => {
	fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(root, ".claude", "workflow-core.json"),
		JSON.stringify(config),
	);
};

/**
 * The rule latches written under `root`'s marker store, by file name: where a
 * host-root core's run left its told rules (#4242).
 */
export const latchesAt = (root: string) => {
	const dir = path.join(root, MARKERS_REL);
	return fs.existsSync(dir)
		? fs.readdirSync(dir).filter((f) => f.startsWith(".rule-injected-"))
		: [];
};

/**
 * Where a core run happens: `root` the host root, `env` the whole
 * environment, `worktree`'s one variable aside, so nothing of the test
 * process's leaks in. `worktree` runs it from that linked worktree of `root`:
 * the hook's cwd and the payload's `cwd`, unless the payload names one, with
 * `CLAUDE_PROJECT_DIR` still `root`. `cwd` stands in for the hook's own.
 */
export interface CoreRunOptions {
	root: string;
	worktree?: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface CoreRun {
	/** Null where silent. */
	output: Output | null;
	logs: string[];
}

/**
 * Run the `event` core `name` on `payload`.
 * `throwing` makes the row's `decide` throw it, for a core with no real fault a
 * case can provoke to reach its row's failure policy.
 */
export function runCore(
	name: string,
	payload: Record<string, unknown>,
	{
		event = "PreToolUse",
		throwing,
		...where
	}: CoreRunOptions & {
		event?: "PreToolUse" | "PostToolUse";
		throwing?: string;
	},
): CoreRun {
	const cores = loadedCores(event).filter((c) => c.name === name);
	if (cores.length !== 1) throw new Error(`no ${event} core named ${name}`);
	const running = throwing
		? cores.map((c) => ({
				...c,
				decide: () => {
					throw new Error(throwing);
				},
			}))
		: cores;
	return dispatchCores(running, payload, where);
}

/**
 * Every `event` core on `payload`, as the entry runs them, its output the
 * one the hook would print.
 */
export function runEventCores(
	payload: Record<string, unknown>,
	{
		event = "PreToolUse",
		...where
	}: CoreRunOptions & { event?: "PreToolUse" | "PostToolUse" },
): CoreRun {
	return dispatchCores(loadedCores(event), payload, where);
}

function dispatchCores(
	cores: ReturnType<typeof loadedCores>,
	payload: Record<string, unknown>,
	{ root, worktree, cwd = worktree ?? root, env: given = {} }: CoreRunOptions,
): CoreRun {
	const env = worktree ? { CLAUDE_PROJECT_DIR: root, ...given } : given;
	const input = worktree ? { cwd: worktree, ...payload } : payload;
	const logs: string[] = [];
	const log = (what: string) => {
		logs.push(what);
	};
	const { output, latches } = dispatch(cores, {
		payload: input,
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
	for (const l of latches)
		writeLatches({ root, payload: input, log }, l.latches);
	return { output, logs };
}
