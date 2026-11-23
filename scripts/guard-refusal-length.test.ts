// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreFile } from "./lib/core-path-testkit";
import { defineTemplate } from "./lib/git-fixture";
import { writePsStub } from "./lib/ps-stub";
import { coreRoot } from "./lib/script-path.js";

const ownBytes = (text: string, ...quoted: string[]) =>
	Buffer.byteLength(
		quoted.reduce((t, q) => t.split(q).join(""), text),
		"utf8",
	);

const overBy = (text: string, ceiling: number, ...quoted: string[]) =>
	ownBytes(text, ...quoted) - ceiling;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-length-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const NO_GIT_ENV = {
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
};

interface Setup {
	env?: Record<string, string | undefined>;
	payload?: Record<string, unknown>;
	quoted?: string[];
}

interface Row {
	text: string;
	guard: string;
	only?: string;
	decision: "deny" | "warn";
	tool?: string;
	input: Record<string, unknown>;
	quotes?: string[];
	spent?: number;
	setup?: () => Setup;
	marks: string;
	measured: number;
	ceiling: number;
}

const running =
	(suites: number, watchers = 0) =>
	(): Setup => {
		const ps = writePsStub(dir, [
			...new Array(suites).fill("node /r/node_modules/.bin/vitest run"),
			...new Array(watchers).fill("node /r/node_modules/.bin/vitest"),
		]);
		const meminfo = path.join(dir, "meminfo");
		fs.writeFileSync(meminfo, `MemAvailable: ${9000 * 1024} kB\n`);
		return {
			env: {
				WFC_READ_GRAPH_RENDERS: "0",
				WFC_MEMINFO: meminfo,
				WFC_PS: ps,
			},
		};
	};

const subagent = (): Setup => ({ payload: { agent_id: "x1" } });
const dispatched = (): Setup => ({
	payload: { hook_event_name: "PreToolUse" },
});

const heavyTreeRule = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/heavy-tree-search.txt"),
		"utf8",
	)
	.trim();

const stagedRepo = defineTemplate((root) => {
	fs.mkdirSync(path.join(root, "app"));
	fs.writeFileSync(path.join(root, "app", "a.ts"), "x\n");
	fs.writeFileSync(path.join(root, "CLAUDE.md"), "x\n");
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", root, ...args], {
			env: { ...process.env, ...NO_GIT_ENV },
		});
	git("init", "-q");
	git("add", "app/a.ts", "CLAUDE.md");
});

const project = (): Setup => {
	const repo = stagedRepo.instantiate(
		fs.realpathSync(fs.mkdtempSync(path.join(dir, "repo-"))),
	);
	return {
		env: { CLAUDE_PROJECT_DIR: repo, ...NO_GIT_ENV },
		payload: { cwd: repo },
		quoted: [repo],
	};
};

const DISPATCH = "guard-dispatch.js";
const CORE = `${coreRoot()}/`;

const ROWS: Row[] = [
	{
		text: "the poll guard's no-op refusal",
		guard: DISPATCH,
		decision: "deny",
		input: { command: "true" },
		spent: 1,
		marks: "Ending a turn is not a tool call",
		measured: 416,
		ceiling: 466,
	},
	{
		text: "the poll guard's output-file re-read refusal",
		guard: DISPATCH,
		decision: "deny",
		tool: "Read",
		input: { file_path: "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output" },
		spent: 2,
		quotes: [CORE],
		marks: "Re-reading a background job's output file",
		measured: 452,
		ceiling: 502,
	},
	{
		text: "the poll guard's ListAgents refusal",
		guard: DISPATCH,
		decision: "deny",
		tool: "ListAgents",
		input: {},
		spent: 2,
		quotes: [CORE],
		marks: "Polling ListAgents",
		measured: 476,
		ceiling: 513,
	},
	{
		text: "the poll guard's timed-check cadence warning",
		guard: DISPATCH,
		decision: "warn",
		input: { command: "sleep 120; wc -c .claude/tmp/agents/a.md" },
		spent: 3,
		quotes: [CORE],
		marks: "Timed checks under two minutes apart",
		measured: 409,
		ceiling: 431,
	},
	{
		text: "the poll guard's job-beat cadence warning",
		guard: DISPATCH,
		decision: "warn",
		input: { command: "sleep 120; scripts/bg-run.sh check suite" },
		spent: 3,
		marks: "Timed job beats under two minutes apart",
		measured: 426,
		ceiling: 476,
	},
	{
		text: "the poll guard's timed-check cadence warning, to a subagent (#1169)",
		guard: DISPATCH,
		decision: "warn",
		input: { command: "sleep 120; wc -c .claude/tmp/agents/a.md" },
		spent: 3,
		setup: subagent,
		quotes: [CORE],
		marks: "Timed checks under two minutes apart",
		measured: 371,
		ceiling: 421,
	},
	{
		text: "the poll guard's job-beat cadence warning, to a subagent (#1169)",
		guard: DISPATCH,
		decision: "warn",
		input: { command: "sleep 120; scripts/bg-run.sh check suite" },
		spent: 3,
		setup: subagent,
		quotes: [CORE],
		marks: "KILLED or UNKNOWN twice",
		measured: 545,
		ceiling: 595,
	},
	{
		text: "the poll guard's no-op refusal, to a subagent (#1169)",
		guard: DISPATCH,
		decision: "deny",
		input: { command: "true" },
		spent: 1,
		setup: subagent,
		quotes: [CORE],
		marks: "A no-op like `true` waits on nothing",
		measured: 375,
		ceiling: 425,
	},
	{
		text: "the poll guard's output-file re-read refusal, to a subagent (#1169)",
		guard: DISPATCH,
		decision: "deny",
		tool: "Read",
		input: { file_path: "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output" },
		spent: 2,
		setup: subagent,
		quotes: [CORE],
		marks: "Re-reading a background job's output file",
		measured: 399,
		ceiling: 449,
	},
	{
		text: "the poll guard's ListAgents refusal, to a subagent (#1169)",
		guard: DISPATCH,
		decision: "deny",
		tool: "ListAgents",
		input: {},
		spent: 2,
		setup: subagent,
		quotes: [CORE],
		marks: "Polling ListAgents is a wait loop",
		measured: 362,
		ceiling: 412,
	},
	{
		text: "the background core's detached-suite refusal",
		guard: "guard-dispatch.js",
		only: "guard-suite-background",
		decision: "deny",
		input: { command: "npm run test &" },
		setup: dispatched,
		quotes: ["npm run test", CORE],
		marks: "DETACHED INSIDE THE SHELL",
		measured: 923,
		ceiling: 945,
	},
	{
		text: "the concurrency refusal handing back a queued launch",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "npm run test" },
		quotes: ["npm run test", CORE],
		setup: running(3),
		marks: "Run instead: npm run test -- --queue",
		measured: 477,
		ceiling: 527,
	},
	{
		text: "the concurrency refusal queueing behind watchers alone",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "npm run test" },
		quotes: ["npm run test", CORE],
		setup: running(0, 3),
		marks: "or the queue waits for good",
		measured: 599,
		ceiling: 649,
	},
	{
		text: "the concurrency refusal for a launch inside a compound command",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "cd app && npm run test" },
		quotes: ["npm run test", CORE],
		setup: running(3),
		marks: "in place of its own",
		measured: 518,
		ceiling: 568,
	},
	{
		text: "the concurrency refusal for a watcher launch",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "npm run test:watch" },
		quotes: ["npm run test:watch"],
		setup: running(3),
		marks: "This opens a WATCHER",
		measured: 750,
		ceiling: 800,
	},
	{
		text: "the concurrency refusal for a watcher launch among one-shots and watchers",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "npm run test:watch" },
		quotes: ["npm run test:watch"],
		setup: running(1, 2),
		marks: "Wait for a one-shot run to finish",
		measured: 831,
		ceiling: 881,
	},
	{
		text: "the concurrency refusal for a watcher launch behind watchers alone",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "npm run test:watch" },
		quotes: ["npm run test:watch"],
		setup: running(0, 3),
		marks: "Every one of them is an open watcher",
		measured: 819,
		ceiling: 869,
	},
	{
		text: "the concurrency refusal for a non-vitest runner, routed through queue-run.js",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "node --test" },
		quotes: ["node --test", CORE],
		setup: running(3),
		marks: `Run instead: node ${coreFile("scripts/queue-run.js")} -- `,
		measured: 375,
		ceiling: 517,
	},
	{
		text: "the concurrency refusal for a non-vitest runner, among watchers only",
		guard: DISPATCH,
		only: "guard-suite-concurrency",
		decision: "deny",
		input: { command: "node --test" },
		quotes: ["node --test"],
		setup: running(0, 3),
		marks: "or the queue waits for good",
		measured: 497,
		ceiling: 598,
	},
	{
		text: "the dot-read guard's root-expansion warning",
		guard: DISPATCH,
		decision: "warn",
		input: { command: "grep -rn foo ." },
		quotes: ["grep -rn foo CLAUDE.md app", heavyTreeRule],
		setup: project,
		marks: "That is your search with its root expanded",
		measured: 615,
		ceiling: 665,
	},
];

const emitted = (row: Row) => {
	const setup = row.setup?.() ?? {};
	const call = () =>
		spawnSync(
			path.resolve(__dirname, row.guard),
			row.only ? ["--only", row.only] : [],
			{
				cwd: dir,
				encoding: "utf8",
				input: JSON.stringify({
					hook_event_name: "PreToolUse",
					session_id: "s1",
					tool_name: row.tool ?? "Bash",
					tool_input: row.input,
					...setup.payload,
				}),
				env: {
					...process.env,
					TMPDIR: dir,
					CLAUDE_CONFIG_DIR: path.join(dir, "config"),
					CLAUDE_PROJECT_DIR: dir,
					...setup.env,
				},
			},
		);
	for (let i = 0; i < (row.spent ?? 0); i++) call();
	const r = call();
	if (r.status === null) throw new Error(`guard did not run: ${r.error}`);
	expect(r.status).toBe(0);
	const out = JSON.parse(r.stdout).hookSpecificOutput;
	expect(out.permissionDecision).toBe(
		row.decision === "deny" ? "deny" : undefined,
	);
	const text: string =
		row.decision === "deny"
			? out.permissionDecisionReason
			: out.additionalContext;
	return { text, quoted: [...(row.quotes ?? []), ...(setup.quoted ?? [])] };
};

describe("measuring a text (#521)", () => {
	it("counts UTF-8 bytes, so an em dash is three", () => {
		expect(ownBytes("a — b")).toBe(7);
	});

	it("takes out every occurrence of each quoted string", () => {
		expect(ownBytes("run x; run x", "x")).toBe(10);
	});

	it("reads a text exactly at its ceiling as within it", () => {
		expect(overBy("run x", 4, "x")).toBe(0);
	});

	it("reads a text one byte past its ceiling as over it", () => {
		expect(overBy("run x", 3, "x")).toBe(1);
	});
});

describe("the rewritten texts stay within their ceilings (#521)", () => {
	it.each(ROWS)("keeps $text within its ceiling", (row) => {
		const { text, quoted } = emitted(row);
		expect(text).toContain(row.marks);
		for (const q of quoted) expect(text, `quotes ${q}`).toContain(q);
		expect(
			overBy(text, row.ceiling, ...quoted),
			`${ownBytes(text, ...quoted)} bytes against a ${row.ceiling}-byte ceiling`,
		).toBeLessThanOrEqual(0);
	});
});
