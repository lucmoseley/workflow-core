import fs from "node:fs";
import path from "node:path";
import { defineTemplate, trioTemplate } from "./git-fixture";
import { loadCores } from "./guard-core-load.js";
import { writeLatches } from "./guard-entry.js";
import { hostAdapters } from "./guard-host-ports.js";
import { dispatch, type Output } from "./guard-judge.js";
import { MARKERS_REL } from "./marker-root.js";
import { readHookPersistChars } from "./rule-emission.js";

// #4153
const MANIFEST = path.join(__dirname, "guard-cores.json");

export const loadedCores = (event: string) => {
	const cores = loadCores(event, { manifest: MANIFEST });
	for (const c of cores)
		if ("loadFault" in c) throw new Error(`${c.name}: ${c.loadFault}`);
	return cores;
};

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

export const latchesAt = (root: string) => {
	const dir = path.join(root, MARKERS_REL);
	return fs.existsSync(dir)
		? fs.readdirSync(dir).filter((f) => f.startsWith(".rule-injected-"))
		: [];
};

export interface CoreRunOptions {
	root: string;
	worktree?: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface CoreRun {
	output: Output | null;
	logs: string[];
}

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
	const env = worktree ? { CLAUDE_PROJECT_DIR: worktree, ...given } : given;
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
