// @vitest-environment node
/*
 * The deny and warn texts #497 cut — guard-agent-poll.sh (#518), the two suite
 * guards (#519) and guard-recursive-dot-read.sh (#520) — may not regrow (#521).
 * Each is pinned at or under a byte ceiling. Only these four guards: the
 * ceiling is not widened to any other (#497 §Implementation Decisions).
 *
 * WHAT IS COUNTED is the guard's own words, in UTF-8 bytes: the text as the
 * session receives it, less the command it quotes back. The dot-read warning
 * also names the project root, a temp path here, and that goes too.
 *
 * A text over its ceiling fails with its measurement. Cut the text; raise the
 * ceiling only on a ruling, re-measuring every row and recording it below.
 *
 * Each guard is spawned and its live text measured, never a copy. All four run
 * as `PreToolUse` Bash hooks (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`), so a ceiling loosened here lets a refusal regrow and
 * every session that trips it pays the bytes #497 cut, on every trip.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePsStub } from "./lib/ps-stub";

/** `text`'s bytes with every occurrence of each of `quoted` taken out. */
const ownBytes = (text: string, ...quoted: string[]) =>
	Buffer.byteLength(
		quoted.reduce((t, q) => t.split(q).join(""), text),
		"utf8",
	);

/** How far `text`'s own bytes run past `ceiling`; zero or less is within it. */
const overBy = (text: string, ceiling: number, ...quoted: string[]) =>
	ownBytes(text, ...quoted) - ceiling;

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "refusal-length-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/* Inherited from a hook or a worktree, these point git at the live index. */
const NO_GIT_ENV = {
	GIT_DIR: undefined,
	GIT_WORK_TREE: undefined,
	GIT_INDEX_FILE: undefined,
};

/** What a row adds to the call, built inside the case's temp dir. */
interface Setup {
	env?: Record<string, string | undefined>;
	payload?: Record<string, unknown>;
	/** Strings the text quotes back that only the setup knows. */
	quoted?: string[];
}

interface Row {
	/** Completes the case title, "keeps … within its ceiling". */
	text: string;
	guard: string;
	decision: "deny" | "warn";
	tool?: string;
	input: Record<string, unknown>;
	/** Caller strings the text quotes back, left out of the count. */
	quotes?: string[];
	/** Identical calls before the measured one — the route's allowance. */
	spent?: number;
	setup?: () => Setup;
	/** A phrase only this branch's text carries, so a case that has drifted
	 * onto a shorter branch fails rather than passing on the wrong text. */
	marks: string;
	/** The text's own bytes when the ceiling was set. */
	measured: number;
	ceiling: number;
}

/**
 * `suites` one-shot runs and `watchers` open watchers already going, with the
 * count cap live. MemAvailable sits far above the ladder so the memory warn
 * never outranks the deny.
 */
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
				WFC_SUITE_CONCURRENT: "",
			},
		};
	};

/** The same call, made by a subagent rather than the session itself. */
const subagent = (): Setup => ({ payload: { agent_id: "x1" } });

/* The rule the dot-read warning carries on its first trip (#2060): route (f)'s
 * cap prices it, so it is not the guard's own words. */
const heavyTreeRule = fs
	.readFileSync(
		path.resolve(__dirname, "../docs/agents/rules/heavy-tree-search.txt"),
		"utf8",
	)
	.trim();

/** A project whose top level is `CLAUDE.md` and `app/`, as the root to expand. */
const project = (): Setup => {
	const repo = fs.realpathSync(fs.mkdtempSync(path.join(dir, "repo-")));
	fs.mkdirSync(path.join(repo, "app"));
	fs.writeFileSync(path.join(repo, "app", "a.ts"), "x\n");
	fs.writeFileSync(path.join(repo, "CLAUDE.md"), "x\n");
	const git = (...args: string[]) =>
		spawnSync("git", ["-C", repo, ...args], {
			env: { ...process.env, ...NO_GIT_ENV },
		});
	git("init", "-q");
	git("add", "app/a.ts", "CLAUDE.md");
	return {
		env: { CLAUDE_PROJECT_DIR: repo, ...NO_GIT_ENV },
		payload: { cwd: repo },
		quoted: [repo],
	};
};

const POLL = "guard-agent-poll.sh";
const CONCURRENCY = "guard-suite-concurrency.sh";

/*
 * Each ceiling is its measurement plus 50 bytes: a reworded clause fits, an
 * added sentence does not. #545 re-measured the four rows it rewrote; each
 * ceiling is now the lower of its old one and the new measurement plus 50.
 */
const ROWS: Row[] = [
	{
		text: "the poll guard's no-op refusal",
		guard: POLL,
		decision: "deny",
		input: { command: "true" },
		spent: 1,
		marks: "Ending a turn is not a tool call",
		measured: 416,
		ceiling: 466,
	},
	{
		text: "the poll guard's output-file re-read refusal",
		guard: POLL,
		decision: "deny",
		tool: "Read",
		input: { file_path: "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output" },
		spent: 2,
		marks: "Re-reading a background job's output file",
		measured: 452,
		ceiling: 502,
	},
	{
		text: "the poll guard's ListAgents refusal",
		guard: POLL,
		decision: "deny",
		tool: "ListAgents",
		input: {},
		spent: 2,
		marks: "Polling ListAgents",
		measured: 476,
		ceiling: 513,
	},
	{
		text: "the poll guard's timed-check cadence warning",
		guard: POLL,
		decision: "warn",
		input: { command: "sleep 120; wc -c .claude/tmp/agents/a.md" },
		spent: 3,
		marks: "Timed checks under two minutes apart",
		measured: 409,
		ceiling: 431,
	},
	{
		text: "the poll guard's job-beat cadence warning",
		guard: POLL,
		decision: "warn",
		input: { command: "sleep 120; scripts/bg-run.sh check suite" },
		spent: 3,
		marks: "Timed job beats under two minutes apart",
		measured: 426,
		ceiling: 476,
	},
	{
		text: "the poll guard's timed-check cadence warning, to a subagent (#1169)",
		guard: POLL,
		decision: "warn",
		input: { command: "sleep 120; wc -c .claude/tmp/agents/a.md" },
		spent: 3,
		setup: subagent,
		marks: "Timed checks under two minutes apart",
		measured: 371,
		ceiling: 421,
	},
	{
		text: "the poll guard's job-beat cadence warning, to a subagent (#1169)",
		guard: POLL,
		decision: "warn",
		input: { command: "sleep 120; scripts/bg-run.sh check suite" },
		spent: 3,
		setup: subagent,
		marks: "KILLED or UNKNOWN twice",
		measured: 545,
		ceiling: 595,
	},
	{
		text: "the poll guard's no-op refusal, to a subagent (#1169)",
		guard: POLL,
		decision: "deny",
		input: { command: "true" },
		spent: 1,
		setup: subagent,
		marks: "A no-op like `true` waits on nothing",
		measured: 375,
		ceiling: 425,
	},
	{
		text: "the poll guard's output-file re-read refusal, to a subagent (#1169)",
		guard: POLL,
		decision: "deny",
		tool: "Read",
		input: { file_path: "/tmp/claude-1000/proj/sess/tasks/bw0192d7i.output" },
		spent: 2,
		setup: subagent,
		marks: "Re-reading a background job's output file",
		measured: 399,
		ceiling: 449,
	},
	{
		text: "the poll guard's ListAgents refusal, to a subagent (#1169)",
		guard: POLL,
		decision: "deny",
		tool: "ListAgents",
		input: {},
		spent: 2,
		setup: subagent,
		marks: "Polling ListAgents is a wait loop",
		measured: 362,
		ceiling: 412,
	},
	{
		text: "the background guard's detached-suite refusal",
		guard: "guard-suite-background.sh",
		decision: "deny",
		input: { command: "npm run test &" },
		quotes: ["npm run test"],
		marks: "DETACHED INSIDE THE SHELL",
		measured: 923,
		ceiling: 945,
	},
	{
		text: "the concurrency refusal handing back a queued launch",
		guard: CONCURRENCY,
		decision: "deny",
		input: { command: "npm run test" },
		quotes: ["npm run test"],
		setup: running(3),
		marks: "Run instead: npm run test -- --queue",
		measured: 477,
		ceiling: 527,
	},
	{
		text: "the concurrency refusal queueing behind watchers alone",
		guard: CONCURRENCY,
		decision: "deny",
		input: { command: "npm run test" },
		quotes: ["npm run test"],
		setup: running(0, 3),
		marks: "or the queue waits for good",
		measured: 599,
		ceiling: 649,
	},
	{
		text: "the concurrency refusal for a launch inside a compound command",
		guard: CONCURRENCY,
		decision: "deny",
		input: { command: "cd app && npm run test" },
		quotes: ["npm run test"],
		setup: running(3),
		marks: "in place of its own",
		measured: 518,
		ceiling: 568,
	},
	{
		text: "the concurrency refusal for a watcher launch",
		guard: CONCURRENCY,
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
		guard: CONCURRENCY,
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
		guard: CONCURRENCY,
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
		guard: CONCURRENCY,
		decision: "deny",
		input: { command: "node --test" },
		quotes: ["node --test"],
		setup: running(3),
		marks: "Run instead: node scripts/queue-run.js -- ",
		measured: 375,
		ceiling: 517,
	},
	{
		text: "the concurrency refusal for a non-vitest runner, among watchers only",
		guard: CONCURRENCY,
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
		guard: "guard-recursive-dot-read.sh",
		decision: "warn",
		input: { command: "grep -rn foo ." },
		quotes: ["grep -rn foo CLAUDE.md app", heavyTreeRule],
		setup: project,
		marks: "That is your search with its root expanded",
		measured: 615,
		ceiling: 665,
	},
];

/** The text the row's guard emits on the measured call, its decision checked. */
const emitted = (row: Row) => {
	const setup = row.setup?.() ?? {};
	const call = () =>
		spawnSync(path.resolve(__dirname, row.guard), [], {
			cwd: dir,
			encoding: "utf8",
			input: JSON.stringify({
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
		});
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
