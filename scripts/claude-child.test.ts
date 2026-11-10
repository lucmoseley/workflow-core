// @vitest-environment node
/*
 * claude-child.js, driven through its command line against a stub `claude`
 * whose `-p` is the headless-run fake, which reads its argv against the
 * harness's recorded options and logs it, its environment and its stdin
 * (#2040).
 *
 * spawn-kept: a real fd (§X3) — the script hands the child real fds —
 * its own stdout and stderr, and the prompt file as stdin.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ADMITTED_AUTH,
	buildAuthStatusBranch,
	REFUSED_AUTH,
	writeSeatHelper,
} from "./lib/auth-status-fake";
import { CHROME_STANDING_LINES } from "./lib/chrome-child.js";
import { writeClaudeStub } from "./lib/claude-stub";
import { readJudgeCalls, writeJudgeFake } from "./lib/gate-judge-fake";
import { JUDGE_ARGS, JUDGE_TIMEOUT_EXIT } from "./lib/gate-judge-mode.js";
import {
	buildHeadlessBranch,
	buildResultRow,
	readHeadlessCalls,
	writeHeadlessFake,
} from "./lib/headless-run-fake";

const SCRIPT = path.resolve(__dirname, "claude-child.js");

let dir = "";
let seat = "";

const callsLog = () => path.join(dir, "calls.jsonl");

/** The stub `claude`, its `-p` run ending `exit`. */
const writeStub = (exit = 0) =>
	writeClaudeStub(path.join(dir, "claude"), [
		buildHeadlessBranch(
			writeHeadlessFake(path.join(dir, "claude-p"), {
				log: callsLog(),
				mode: "end",
				text: "child said hello\n",
				exit,
			}),
		),
	]);

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-child-"));
	seat = path.join(dir, ".claude");
	fs.mkdirSync(seat);
	writeStub();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const run = (
	args: string[],
	extra: Record<string, string> = {},
	input?: string,
) =>
	spawnSync(process.execPath, [SCRIPT, ...args], {
		encoding: "utf8",
		input,
		env: {
			...process.env,
			CLAUDE_CONFIG_DIR: seat,
			CLAUDE_PROJECT_DIR: dir,
			WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
			WFC_CLAUDE_CONFIG_B: path.join(dir, ".claude2"),
			WFC_CLAUDE_CONFIG_C: path.join(dir, ".claude3"),
			WFC_CLAUDE_BIN: path.join(dir, "claude"),
			...extra,
		},
	});

const readSeen = () => {
	const [seen] = readHeadlessCalls(callsLog());
	if (!seen) throw new Error("the child was never launched");
	return seen;
};
const launched = () => readHeadlessCalls(callsLog()).length > 0;

describe("usage", () => {
	it("runs /usage on the named seat, approving no tool", () => {
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("child said hello\n");
		expect(readSeen().argv).toEqual([
			"-p",
			"/usage",
			"--permission-mode",
			"manual",
		]);
		expect(readSeen().env.CLAUDE_CONFIG_DIR).toBe(seat);
	});

	it("passes on the child's exit status", () => {
		writeStub(3);
		expect(run(["usage", "--config-dir", seat]).status).toBe(3);
	});

	it("refuses a binary that cannot answer for its auth, naming the cached reading", () => {
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: path.join(dir, "missing"),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("auth status` failed");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});

	it("names the cached reading where the child cannot start", () => {
		/* Answers `auth status`, then is gone before the launch. */
		const vanishing = path.join(dir, "vanishing");
		fs.writeFileSync(
			vanishing,
			`#!/bin/bash\nif [ "$1" = "auth" ]; then rm -- "$0"; fi\n${buildAuthStatusBranch()}\n`,
			{ mode: 0o755 },
		);
		const r = run(["usage", "--config-dir", seat], {
			WFC_CLAUDE_BIN: vanishing,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("the child did not finish");
		expect(r.stderr).toContain("allowance.js --config-dir");
	});
});

describe("chrome", () => {
	const prompt = () => {
		const f = path.join(dir, "prompt.md");
		fs.writeFileSync(f, "Read example.com and report.\n");
		return f;
	};

	it("gives the child the Chrome tools only, file_upload barred, 10 turns a page plus 5, the prompt on stdin", () => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"2",
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(0);
		expect(readSeen().argv).toEqual([
			"-p",
			"--chrome",
			"--tools",
			"",
			"--allowedTools",
			"mcp__claude-in-chrome__*",
			"--disallowedTools",
			"mcp__claude-in-chrome__file_upload",
			"--max-turns",
			"25",
			"--output-format",
			"stream-json",
			"--verbose",
			"--append-system-prompt",
			CHROME_STANDING_LINES,
		]);
		expect(readSeen().stdinText).toBe("Read example.com and report.\n");
		expect(readSeen().env.CLAUDE_CONFIG_DIR).toBe(seat);
	});

	/** A stream row carrying one Chrome tool result's text parts. */
	const toolResult = (...texts: string[]) => ({
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "toolu_1",
					content: texts.map((text) => ({ type: "text", text })),
				},
			],
		},
	});
	const tabContext = (...tabs: [number, string][]) =>
		`\n\nTab Context:\n- Available tabs:\n${tabs.map(([id, url]) => `  • tabId ${id}: "A page" ("${url}")`).join("\n")}`;
	/** The stub's `-p` run printing `rows` as its stream. */
	const writeStream = (rows: Record<string, unknown>[], exit = 0) =>
		writeClaudeStub(path.join(dir, "claude"), [
			buildHeadlessBranch(
				writeHeadlessFake(path.join(dir, "claude-p"), {
					log: callsLog(),
					mode: "end",
					rows,
					exit,
				}),
			),
		]);
	const chrome = () =>
		run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"1",
			"--prompt-file",
			prompt(),
		]);

	it("prints the result row alone, no tab left where the child closed its group", () => {
		writeStream([
			{ type: "system", subtype: "init" },
			toolResult(
				'{"availableTabs":[{"tabId":7}]}',
				tabContext([7, "chrome://newtab/"]),
			),
			toolResult("Closed tab 7. Group is now empty (auto-removed)."),
			buildResultRow({ result: "read it" }),
		]);
		const r = chrome();
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		const lines = r.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			subtype: "success",
			result: "read it",
			tabsLeftOpen: [],
		});
	});

	it("names each tab the child left open, in the result and on stderr, keeping the child's status", () => {
		writeStream([
			toolResult(tabContext([7, "chrome://newtab/"])),
			toolResult(
				"Created new tab. Tab ID: 8",
				tabContext([7, "chrome://newtab/"], [8, "https://example.com/"]),
			),
			toolResult(
				"Closed tab 7. 1 tab(s) remain.",
				tabContext([8, "https://example.com/"]),
			),
			buildResultRow(),
		]);
		const r = chrome();
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).tabsLeftOpen).toEqual([
			{ tabId: 8, title: "A page", url: "https://example.com/" },
		]);
		expect(r.stderr).toBe(
			"claude-child: the child left 1 tab(s) open in its Claude tab group: 8 (https://example.com/)\n",
		);
	});

	it("names the tabs left by a child that ended with no result row", () => {
		writeStream([toolResult(tabContext([7, "https://example.com/"]))], 1);
		const r = chrome();
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("7 (https://example.com/)");
	});

	it("passes on a line that is no stream row", () => {
		writeStub(1);
		const r = chrome();
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("child said hello\n");
	});

	it.each([
		["seven pages", ["--pages", "7"], "at most 6"],
		["no pages", ["--pages", "0"], "from 1 to 6"],
		["a page count that is not a number", ["--pages", "two"], "from 1 to 6"],
	])("refuses %s, launching nothing", (_, pages, says) => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			...pages,
			"--prompt-file",
			prompt(),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});

	it("refuses a missing prompt file, launching nothing", () => {
		const r = run([
			"chrome",
			"--config-dir",
			seat,
			"--pages",
			"1",
			"--prompt-file",
			path.join(dir, "nope.md"),
		]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("could not read the prompt file");
		expect(launched()).toBe(false);
	});
});

describe("judge", () => {
	const judgeLog = () => path.join(dir, "judge-calls.jsonl");
	const judge = (ms = "60000", extra: Record<string, string> = {}) =>
		run(
			["judge", "--config-dir", seat, "--timeout-ms", ms],
			{ WFC_CLAUDE_BIN: path.join(dir, "claude-judge"), ...extra },
			"What waits does this body make?\n",
		);
	const writeFake = (plan: Parameters<typeof writeJudgeFake>[2]) =>
		writeJudgeFake(path.join(dir, "claude-judge"), judgeLog(), plan);
	const readJudged = () => {
		const seen = readJudgeCalls(judgeLog()).at(-1);
		if (!seen) throw new Error("the judge child was never launched");
		return seen;
	};

	beforeEach(() => {
		writeFake({ stdout: "child said hello\n" });
	});

	it("gives the child the judge mode's flags, the prompt on stdin, in an empty directory", () => {
		const r = judge();
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("child said hello\n");
		expect(readJudged().argv).toEqual(JUDGE_ARGS);
		expect(readJudged().argv).toEqual(
			expect.arrayContaining([
				"haiku",
				"--tools",
				"--setting-sources",
				"--strict-mcp-config",
				"--disable-slash-commands",
				"--no-session-persistence",
				"--json-schema",
			]),
		);
		expect(readJudged().stdin).toBe("What waits does this body make?\n");
		expect(readJudged().cwdEntries).toEqual([]);
		expect(readJudged().cwd).not.toBe(process.cwd());
		expect(readJudged().configDir).toBe(seat);
	});

	it("empties its working directory of what a call before it left", () => {
		judge();
		fs.writeFileSync(path.join(readJudged().cwd, "left-behind.txt"), "x\n");
		expect(judge().status).toBe(0);
		expect(readJudgeCalls(judgeLog())).toHaveLength(2);
		expect(readJudged().cwdEntries).toEqual([]);
	});

	it("kills a child still running at the bound, exiting as a timeout does", () => {
		writeFake({ hang: true });
		const r = judge("1500");
		expect(r.status).toBe(JUDGE_TIMEOUT_EXIT);
		expect(r.stderr).toContain("the child was killed at its 1500 ms bound");
	});

	it.each([
		["no bound", ["judge", "--config-dir", "SEAT"]],
		[
			"a bound that is no number",
			["judge", "--config-dir", "SEAT", "--timeout-ms", "soon"],
		],
		[
			"a bound of nothing",
			["judge", "--config-dir", "SEAT", "--timeout-ms", "0"],
		],
	])("refuses %s, launching nothing", (_, args) => {
		const r = run(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--timeout-ms is a whole number");
		expect(launched()).toBe(false);
	});

	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		const r = judge("60000", env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(readJudgeCalls(judgeLog())).toEqual([]);
	});
});

describe("refuses, launching nothing", () => {
	it.each([
		[
			"a config dir that is not a seat",
			["usage", "--config-dir", "/tmp/elsewhere"],
			"not one of this machine's seats",
		],
		["no config dir", ["usage"], "--config-dir is required"],
		[
			"a flag no mode takes",
			["usage", "--config-dir", "SEAT", "--dangerously-skip-permissions"],
			"unknown flag",
		],
		[
			"a chrome flag on usage",
			["usage", "--config-dir", "SEAT", "--pages", "1"],
			"unknown flag",
		],
		[
			"a free prompt",
			["usage", "--config-dir", "SEAT", "do anything"],
			"do anything",
		],
		["no mode", ["--config-dir", "SEAT"], "a command is required"],
		["an unknown mode", ["print", "--config-dir", "SEAT"], "unknown command"],
	])("%s", (_, args, says) => {
		const r = run(args.map((a) => (a === "SEAT" ? seat : a)));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(says);
		expect(launched()).toBe(false);
	});
});

describe("the launch's auth (#2236)", () => {
	it.each(REFUSED_AUTH)("refuses under %s, launching nothing", (name, env) => {
		const r = run(["usage", "--config-dir", seat], env);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`${name} is set`);
		expect(r.stderr).toContain("#2236");
		expect(launched()).toBe(false);
	});

	it("refuses an apiKeyHelper in the seat's settings", () => {
		writeSeatHelper(seat);
		const r = run(["usage", "--config-dir", seat]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("apiKeyHelper");
		expect(launched()).toBe(false);
	});

	it.each(ADMITTED_AUTH)("launches on %s", (_name, env) => {
		expect(run(["usage", "--config-dir", seat], env).status).toBe(0);
		expect(launched()).toBe(true);
	});
});
