import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { dispatch } from "./precommit-dispatch.js";
import { existsUnder, readStaged } from "./precommit-dispatch-ports.js";
import { GATES } from "./precommit-gates.js";
import { shellQuote } from "./sh-quote.js";

export const ROOT = path.join(__dirname, "..", "..");

export const HOOK = fs.readFileSync(
	path.join(ROOT, ".husky", "pre-commit"),
	"utf8",
);

export const CORE_ROOT = `"\${WFC_PLUGIN_ROOT:-.}"/`;

export const coreCall = (runner: string, script: string) =>
	`${runner} ${CORE_ROOT}${script}`;

type DispatchPorts = Parameters<typeof dispatch>[0]["ports"];

export const buildRepoPorts = (
	root: string,
	over: Partial<DispatchPorts> & Pick<DispatchPorts, "load">,
): DispatchPorts => ({
	staged: () => readStaged(root),
	computed: () => [],
	exists: existsUnder(root),
	write: () => undefined,
	interrupted: async () => null,
	...over,
});

export type GateRow = (typeof GATES)[number];

type PatternRow = GateRow & { arm: { pattern: RegExp } };

export function patternRow(script: string): PatternRow {
	const row = GATES.find((g) => g.script === script);
	if (!row || !("pattern" in row.arm))
		throw new Error(`no pattern row for ${script} in lib/precommit-gates.js`);
	return row as PatternRow;
}

export async function dispatchStubbed(
	root: string,
	row: GateRow,
	{
		result = { exit: 0, stdout: "", stderr: "" },
		ports = {},
	}: {
		result?: { exit: number; stdout: string; stderr: string };
		ports?: Partial<DispatchPorts>;
	} = {},
): Promise<{ code: number; ran: boolean; output: string }> {
	let ran = false;
	let output = "";
	const code = await dispatch({
		rows: [row],
		gates: "all",
		ports: buildRepoPorts(root, {
			load: () => () => {
				ran = true;
				return result;
			},
			write: (_fd, text) => {
				output += text;
			},
			...ports,
		}),
	});
	return { code, ran, output };
}

export function cutHookBlock(first: string, last: string): string {
	const lines = HOOK.split("\n");
	const start = lines.findIndex((l) => l.startsWith(first));
	if (start === -1) throw new Error(`no ${first} in .husky/pre-commit`);
	const end = lines.findIndex((l, i) => i > start && l === last);
	if (end === -1) throw new Error(`${first} is unclosed in .husky/pre-commit`);
	return lines.slice(start, end + 1).join("\n");
}

// guess, #2627
const HOLD_DEADLINE_MS = 10_000;

export function holdLock(lock: string): { release: () => void } {
	const ready = `${lock}.held`;
	const stop = `${lock}.release`;
	const holder = spawn(
		"sh",
		[
			"-c",
			`exec 9>>${shellQuote(lock)}; flock 9; touch ${shellQuote(ready)}; while [ ! -e ${shellQuote(stop)} ]; do sleep 0.05; done`,
		],
		{ stdio: "ignore" },
	);
	const release = () => {
		fs.writeFileSync(stop, "");
		holder.kill();
	};
	const deadline = Date.now() + HOLD_DEADLINE_MS;
	while (!fs.existsSync(ready) && Date.now() < deadline) {
		execFileSync("sleep", ["0.05"]);
	}
	if (!fs.existsSync(ready)) {
		release();
		throw new Error(`the holder never took ${lock}`);
	}
	return { release };
}

export const LIB = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "precommit-gate.sh"),
	"utf8",
);

export const LOCAL_HOOK_LIB = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "local-hook.sh"),
	"utf8",
);

export const HOOK_BOUND_LIB = fs.readFileSync(
	path.join(ROOT, "scripts", "lib", "hook-bound.sh"),
	"utf8",
);

export const LIB_COMMANDS = [
	"git",
	"grep",
	"mktemp",
	"tr",
	"paste",
	"cut",
	"rm",
];

export function plantSequencer(root: string, rev: string): void {
	const dir = path.join(root, ".git", "sequencer");
	fs.mkdirSync(dir);
	fs.writeFileSync(
		path.join(dir, "abort-safety"),
		execFileSync("git", ["rev-parse", rev], { cwd: root, encoding: "utf8" }),
	);
}

export function commitOverSequencer(
	root: string,
	live: boolean,
	args = ["--allow-empty"],
): void {
	plantSequencer(root, "HEAD");
	const { GIT_REFLOG_ACTION: _, ...env } = process.env;
	execFileSync("git", ["commit", "-q", "-m", "two", ...args], {
		cwd: root,
		env: live ? { ...env, GIT_REFLOG_ACTION: "revert" } : env,
	});
}

export const LOCAL_GATE_OPEN = "if [ -f .husky/pre-commit.local ]; then";

export function cutLocalGateBlock(hook: string = HOOK): string {
	const lines = hook.split("\n");
	const start = lines.indexOf(LOCAL_GATE_OPEN);
	if (start === -1) throw new Error("no pre-commit.local block in the hook");
	const end = lines.findIndex((l, i) => i > start && l === "fi");
	if (end === -1) throw new Error("the pre-commit.local block is unclosed");
	return lines.slice(start, end + 1).join("\n");
}

export function writeCheckerDelegates(root: string, names: string[]): void {
	for (const name of names) {
		fs.mkdirSync(path.dirname(path.join(root, "scripts", name)), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, "scripts", name),
			"const { spawnSync } = require('node:child_process');\n" +
				"const os = require('node:os');\n" +
				`const r = spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, "scripts", name))}, ...process.argv.slice(2)], { stdio: 'inherit' });\n` +
				"process.exit(r.status ?? (r.signal ? 128 + os.constants.signals[r.signal] : 1));\n",
		);
	}
}
