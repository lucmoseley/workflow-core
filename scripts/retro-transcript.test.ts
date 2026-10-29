// @vitest-environment node
/*
 * retro-transcript.test.ts — pins what the log reducer keeps, drops, cuts and
 * masks, where it may write, and that it streams a large log rather than
 * loading it whole. The log reducer driven as a program against
 * fixture logs, asserting on its output and exit code only (#962). Break it
 * and a retro subagent reads a transcript missing the faults it looks for, or
 * a reduction that loads a large log whole.
 *
 * Every case runs in-process (scripts/lib/run-in-process.js, §X3) except the
 * memory bound. spawn-kept: a process's peak RSS, under node's heap flags and
 * a preload, is a property of a fresh node of its own. That case also measures a
 * whole-file read of the same log, so the bound is shown to separate streaming
 * from loading rather than merely to pass.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_PROMPT, IDLE_PROMPT } from "./lib/loop-prompts.js";
import { runInProcess } from "./lib/run-in-process";
import { buildBashCall } from "./lib/transcript-testkit";

const SCRIPT = path.resolve(__dirname, "retro-transcript.js");
const SID = "11111111-2222-3333-4444-555555555555";

let repo: string;
let logs: string;

beforeEach(() => {
	repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retro-tx-")));
	execFileSync("git", ["init", "-q", repo]);
	logs = path.join(repo, "logs");
	fs.mkdirSync(logs);
});
afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

const run = (args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: repo,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			WFC_SECRETS_FILE: path.join(repo, "secrets.env"),
		},
	});

const writeLog = (file: string, records: unknown[]) =>
	fs.writeFileSync(
		file,
		`${records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")}\n`,
	);

const sessionLog = (records: unknown[]) => {
	const file = path.join(logs, `${SID}.jsonl`);
	writeLog(file, records);
	return file;
};

const readTranscript = (stdout: string) =>
	fs.readFileSync(stdout.split("\n")[0], "utf8").trimEnd().split("\n");

const T = "2026-10-08T09:00:00.000Z";
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
	type: "user",
	timestamp: T,
	message: { role: "user", content },
	...extra,
});
const assistant = (
	content: unknown[],
	extra: Record<string, unknown> = {},
) => ({
	type: "assistant",
	timestamp: T,
	message: { role: "assistant", content },
	...extra,
});
const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
	assistant([{ type: "tool_use", id, name, input }]);
const toolResult = (content: unknown, isError = false) =>
	user([{ type: "tool_result", tool_use_id: "t", content, is_error: isError }]);
const attachment = (payload: Record<string, unknown>) => ({
	type: "attachment",
	timestamp: T,
	attachment: payload,
});
const system = (subtype: string, extra: Record<string, unknown> = {}) => ({
	type: "system",
	subtype,
	timestamp: T,
	...extra,
});

/** One of each kept kind, then one of each dropped kind, in that order. */
const KEPT = [
	user("please fix the guard", { origin: { kind: "human" } }), // L1
	assistant([
		{ type: "thinking", thinking: "DROPPED-THINKING" },
		{ type: "text", text: "Reading the guard." },
	]), // L2
	buildBashCall("npm run lint", "t1", { timestamp: T }), // L3
	toolResult("lint clean"), // L4
	toolResult([{ type: "text", text: "boom: no such file" }], true), // L5
	attachment({
		type: "hook_blocking_error",
		hookName: "PreToolUse:Bash",
		blockingError: { blockingError: "guard refused the push" },
	}), // L6
	attachment({
		type: "hook_additional_context",
		hookName: "PreToolUse:Write",
		content: ["claim the file first"],
	}), // L7
	user("Stop hook feedback:\nanswer the question", { isMeta: true }), // L8
	system("stop_hook_summary", {
		hookErrors: ["refused a bare marker"],
		preventedContinuation: false,
	}), // L9
	system("compact_boundary", { compactMetadata: { trigger: "auto" } }), // L10
	assistant([{ type: "text", text: "API Error: stream stalled" }], {
		isApiErrorMessage: true,
		error: "server_error",
	}), // L11
	system("api_error", { error: { formatted: "No response from API" } }), // L12
	attachment({
		type: "queued_command",
		commandMode: "prompt",
		prompt: "short beard only",
		origin: { kind: "human" },
	}), // L13
];
const DROPPED = [
	user("DROPPED-SUMMARY of the compacted turns", { isCompactSummary: true }),
	user("<task-notification>DROPPED-NOTIFICATION</task-notification>", {
		origin: { kind: "task-notification" },
	}),
	user("DROPPED-PEER message", { isMeta: true, origin: { kind: "peer" } }),
	user([{ type: "text", text: "DROPPED-SKILL body" }], { isMeta: true }),
	attachment({ type: "hook_success", content: "DROPPED-HOOK-SUCCESS" }),
	attachment({
		type: "queued_command",
		commandMode: "prompt",
		prompt: "DROPPED-PEER queued",
		origin: { kind: "peer" },
	}),
	attachment({
		type: "queued_command",
		commandMode: "task-notification",
		prompt: "DROPPED-QUEUED-NOTIFICATION",
	}),
	attachment({ type: "total_tokens_reminder", content: "DROPPED-REMINDER" }),
	system("stop_hook_summary", { hookErrors: [], stopReason: "DROPPED-QUIET" }),
	system("turn_duration", { durationMs: 1 }),
	{ type: "custom-title", customTitle: "DROPPED-TITLE" },
	{ ...user("DROPPED-SIDECHAIN inline"), isSidechain: true },
];

describe("reduction", () => {
	it("keeps every kept kind, each opening with its source line number", () => {
		const log = sessionLog([...KEPT, ...DROPPED]);
		const r = run([log]);
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(readTranscript(r.stdout)).toEqual([
			"L1 09:00:00 FOUNDER: please fix the guard",
			"L2 09:00:00 ASSISTANT: Reading the guard.",
			"L3 09:00:00 TOOL Bash: npm run lint",
			"L4 09:00:00 RESULT: lint clean",
			"L5 09:00:00 RESULT ERROR: boom: no such file",
			"L6 09:00:00 HOOK BLOCK PreToolUse:Bash: guard refused the push",
			"L7 09:00:00 HOOK PreToolUse:Write: claim the file first",
			"L8 09:00:00 HOOK Stop: Stop hook feedback: | answer the question",
			"L9 09:00:00 HOOK Stop summary: refused a bare marker",
			'L10 09:00:00 ===== COMPACTION: {"trigger":"auto"}',
			"L11 09:00:00 API-ERROR server_error: API Error: stream stalled",
			"L12 09:00:00 API-ERROR: No response from API",
			"L13 09:00:00 FOUNDER queued: short beard only",
		]);
	});

	it("drops every dropped kind", () => {
		const log = sessionLog([
			...DROPPED,
			user("only me", { origin: { kind: "human" } }),
		]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const out = readTranscript(r.stdout).join("\n");
		expect(out).not.toMatch(/DROPPED/);
		expect(out).toBe(`L${DROPPED.length + 1} 09:00:00 FOUNDER: only me`);
	});

	it("labels a refill-loop resume prompt LOOP, never FOUNDER, though its origin is human (#3381)", () => {
		const log = sessionLog([
			user(API_PROMPT, { origin: { kind: "human" } }),
			attachment({
				type: "queued_command",
				commandMode: "prompt",
				prompt: IDLE_PROMPT,
				origin: { kind: "human" },
			}),
		]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const out = readTranscript(r.stdout);
		expect(out).toEqual([
			`L1 09:00:00 LOOP: ${API_PROMPT}`,
			`L2 09:00:00 LOOP queued: ${IDLE_PROMPT}`,
		]);
	});

	it("cuts a long tool result to 300 characters and marks the cut", () => {
		const log = sessionLog([toolResult(`${"a".repeat(300)}TAIL`)]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const [line] = readTranscript(r.stdout);
		expect(line).toBe(`L1 09:00:00 RESULT: ${"a".repeat(300)}…`);
	});

	it("skips an unparseable line, counts it, and keeps numbering by the file", () => {
		const log = sessionLog(['{"type":"user", half-writ', KEPT[0]]);
		const r = run([log]);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/1 unparseable log lines skipped/);
		expect(readTranscript(r.stdout)).toEqual([
			"L2 09:00:00 FOUNDER: please fix the guard",
		]);
	});
});

/* Each token split across a template literal, so the secrets scan reads none
 * of them as a live credential. */
const TOKENS: [string, string][] = [
	["huggingface", `hf_${"Qm7pXz2Lr9KfT4vWn8BcYd3Hs6Ja1EuGo5"}`],
	["anthropic", `sk-ant-${"api03-Zx8Kq2Wm9Lr4Tp7Vn3Bc6Yd1Hs5Ja0Eu"}`],
	["openai", `sk-proj-${"Fz3Rt8Lm2Wq9Kp4Vn7Bc1Yd6Hs0Ja5Eu"}`],
	["github", `ghp_${"Kd9Wq3Lr7Tp2Vn8Bc4Yd6Hs1Ja5EuGo0Mx3Z"}`],
	["github", `ghs_${"Rt5Lm8Wq2Kp7Vn4Bc9Yd1Hs6Ja3EuGo0Mx2Q"}`],
	["github-pat", `github_pat_${"11ABCDEFG0aBcDeFgHiJkL_mNoPqRsTuVwXyZ012345"}`],
	["aws", `AKIA${"Z3XQ7LMNB4RTVKWD"}`],
];

describe("token masking (#1031)", () => {
	it("writes no raw token from a founder line, a tool input, a tool result or a subagent", () => {
		const log = sessionLog(
			TOKENS.flatMap(([, token]) => [
				user(`here is the key ${token} thanks`, {
					origin: { kind: "human" },
				}),
				buildBashCall(`echo ${token} > .env`, "t", { timestamp: T }),
				toolResult(`wrote ${token}`),
			]),
		);
		fs.mkdirSync(path.join(logs, SID, "subagents"), { recursive: true });
		writeLog(path.join(logs, SID, "subagents", "agent-x1.jsonl"), [
			{
				...assistant([{ type: "text", text: TOKENS[0][1] }]),
				isSidechain: true,
			},
		]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const out = readTranscript(r.stdout).join("\n");
		for (const [rule, token] of TOKENS) {
			expect(out).not.toContain(token);
			expect(out).toContain(`[REDACTED:${rule}]`);
		}
		/* Each token in three lines, and the first once more in the subagent. */
		expect(r.stdout).toMatch(
			new RegExp(
				`, ${TOKENS.length * 3 + 1} token-shaped substrings masked\\n$`,
			),
		);
	});

	it("masks the value of a name the secrets file holds, in any shape (#3661)", () => {
		const value = `vck_${"aB3".repeat(16)}`;
		fs.writeFileSync(path.join(repo, "secrets.env"), "AI_GATEWAY_API_KEY=x\n");
		const log = sessionLog([
			buildBashCall(`AI_GATEWAY_API_KEY=${value} node a.js`, "t", {
				timestamp: T,
			}),
		]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const out = readTranscript(r.stdout).join("\n");
		expect(out).not.toContain(value);
		expect(out).toContain("AI_GATEWAY_API_KEY=[REDACTED:stored]");
	});

	it("stops before writing a line where the secrets file is there but unreadable (#3661)", () => {
		fs.mkdirSync(path.join(repo, "secrets.env"));
		const log = sessionLog([toolResult("AI_GATEWAY_API_KEY=x")]);
		const r = run([log]);
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("EISDIR");
		expect(r.stdout).toBe("");
	});

	it("masks a token on its own line inside an object tool input", () => {
		const token = TOKENS[0][1];
		const log = sessionLog([
			toolUse("t", "mcp__github__create_issue", { body: `line one\n${token}` }),
		]);
		const r = run([log]);
		expect(readTranscript(r.stdout).join("\n")).not.toContain(token);
	});

	it("leaves no fragment of a token straddling the 300-character cut", () => {
		const token = TOKENS[0][1];
		const log = sessionLog([toolResult(`${"a".repeat(287)} ${token} tail`)]);
		const r = run([log]);
		expect(r.status).toBe(0);
		const [line] = readTranscript(r.stdout);
		expect(line).not.toContain(token.slice(0, 10));
		expect(line).toContain("[REDACTED:hu");
	});

	it.each([
		"task-notification",
		"sk-learn",
		"risk-assessment-for-the-long-hyphenated-phrase-2",
		`hf_${"Short12"}`,
	])("leaves %s unmasked", (text) => {
		const log = sessionLog([user(text, { origin: { kind: "human" } })]);
		const r = run([log]);
		expect(readTranscript(r.stdout)).toEqual([`L1 09:00:00 FOUNDER: ${text}`]);
		expect(r.stdout).not.toMatch(/masked/);
	});
});

describe("subagent folding", () => {
	const subDir = (sid: string) => path.join(logs, sid, "subagents");
	const writeSub = (
		agent: string,
		meta: Record<string, unknown> | null,
		records: unknown[],
	) => {
		fs.mkdirSync(subDir(SID), { recursive: true });
		writeLog(path.join(subDir(SID), `agent-${agent}.jsonl`), records);
		if (meta)
			fs.writeFileSync(
				path.join(subDir(SID), `agent-${agent}.meta.json`),
				JSON.stringify(meta),
			);
	};
	/* Every subagent record carries isSidechain relative to its parent; the
	 * reducer must not drop them for it (lib/transcript.js, mantahostels#1779). */
	const sub = (r: Record<string, unknown>) => ({ ...r, isSidechain: true });

	it("folds a subagent under its dispatching call, labelled by its description", () => {
		const log = sessionLog([
			user("review it", { origin: { kind: "human" } }),
			toolUse("toolu_A", "Agent", {
				description: "Review the diff",
				subagent_type: "code-reviewer",
				prompt: "Read the diff",
			}),
			toolResult("review done"),
		]);
		writeSub(
			"abc123",
			{ description: "Review the diff", toolUseId: "toolu_A" },
			[
				sub(user("Read the diff")),
				sub(toolUse("x", "Read", { file_path: "/repo/a.js" })),
				sub(toolResult("ENOENT", true)),
			],
		);
		const r = run([log]);
		expect(r.status).toBe(0);
		expect(readTranscript(r.stdout)).toEqual([
			"L1 09:00:00 FOUNDER: review it",
			"L2 09:00:00 TOOL Agent: Review the diff / code-reviewer / Read the diff",
			'  L2 ┌ subagent abc123 "Review the diff" (agent-abc123.jsonl)',
			"  [abc123] L1 09:00:00 PROMPT: Read the diff",
			"  [abc123] L2 09:00:00 TOOL Read: /repo/a.js",
			"  [abc123] L3 09:00:00 RESULT ERROR: ENOENT",
			"  L2 └ end subagent abc123",
			"L3 09:00:00 RESULT: review done",
		]);
	});

	it("appends a subagent whose dispatching call is in no log, saying so", () => {
		const log = sessionLog([user("hi", { origin: { kind: "human" } })]);
		writeSub("lost1", null, [sub(user("orphan prompt"))]);
		const r = run([log]);
		expect(r.status).toBe(0);
		expect(readTranscript(r.stdout)).toEqual([
			"L1 09:00:00 FOUNDER: hi",
			'L1 ┌ subagent lost1 "(no .meta.json description)" (agent-lost1.jsonl) — its dispatching call is in no log read here',
			"[lost1] L1 09:00:00 PROMPT: orphan prompt",
			"L1 └ end subagent lost1",
		]);
	});
});

describe("output path", () => {
	const log = () => {
		const file = path.join(logs, `${SID}.jsonl`);
		writeLog(file, [KEPT[0]]);
		return file;
	};

	it("writes under .claude/tmp/retro-transcripts/ by default", () => {
		const r = run([log()]);
		expect(r.status).toBe(0);
		const out = path.join(repo, ".claude/tmp/retro-transcripts", `${SID}.txt`);
		expect(r.stdout).toBe(`${out}\n1 lines\n`);
		expect(fs.existsSync(out)).toBe(true);
	});

	it("takes an --out under .claude/tmp/", () => {
		const out = path.join(repo, ".claude/tmp/run-1/s1.txt");
		const r = run([log(), "--out", out]);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(out, "utf8")).toMatch(/^L1 /);
	});

	it("refuses an --out outside .claude/tmp/, naming it and the way out, and creates nothing", () => {
		const out = path.join(repo, "docs/new/transcript.txt");
		const r = run([log(), "--out", out]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`refused: ${out} is outside`);
		expect(r.stderr).toContain("or omit --out");
		expect(fs.existsSync(path.join(repo, "docs"))).toBe(false);
	});

	it("refuses a symlink out of .claude/tmp/, offering to omit --out", () => {
		fs.mkdirSync(path.join(repo, ".claude/tmp"), { recursive: true });
		fs.mkdirSync(path.join(repo, "docs"));
		fs.symlinkSync(path.join(repo, "docs"), path.join(repo, ".claude/tmp/out"));
		const r = run([log(), "--out", path.join(repo, ".claude/tmp/out/t.txt")]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/is outside/);
		expect(r.stderr).toContain("or omit --out");
	});

	it("refuses when git cannot say whether the path is tracked, offering to omit --out", () => {
		fs.rmSync(path.join(repo, ".git"), { recursive: true });
		const r = run([log()]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/refused: git cannot say whether .* is tracked/);
		expect(r.stderr).toContain("or omit --out");
	});

	it("refuses a tracked path even under .claude/tmp/, naming it and leaving it as it was", () => {
		const out = path.join(repo, ".claude/tmp/kept.txt");
		fs.mkdirSync(path.dirname(out), { recursive: true });
		fs.writeFileSync(out, "tracked\n");
		execFileSync("git", ["add", "-f", out], { cwd: repo });
		const r = run([log(), "--out", out]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`refused: ${out} is a tracked file`);
		expect(fs.readFileSync(out, "utf8")).toBe("tracked\n");
	});

	it("exits 1 naming a log it cannot read", () => {
		const missing = path.join(logs, "nope.jsonl");
		const r = run([missing]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`cannot read ${missing}`);
		expect(r.stderr).toContain("Pass a session's <id>.jsonl");
	});

	it("exits 1 on a directory given as the log, naming it and writing no transcript", () => {
		const r = run([logs]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`cannot read ${logs} as a log file`);
		expect(
			fs.existsSync(path.join(repo, ".claude/tmp/retro-transcripts/logs.txt")),
		).toBe(false);
	});
});

describe("memory bound", () => {
	/** Peak RSS in KB of `node <args>`, through a preload that records it. */
	const peakKb = (args: string[]) => {
		const preload = path.join(repo, "peak.js");
		const record = path.join(repo, "peak.txt");
		fs.writeFileSync(
			preload,
			`process.on("exit", () => require("fs").writeFileSync(${JSON.stringify(record)}, String(process.resourceUsage().maxRSS)));`,
		);
		/* A small heap and nursery so GC runs promptly: without them a streaming
		 * read's garbage lingers and its peak tracks the file size anyway. 24 MB:
		 * compiling lib/token-shapes.js's patterns peaked at 13.7 MB of heap,
		 * measured on a one-line log, too close to 16 (#3661). */
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_PROJECT_DIR: repo,
			WFC_SECRETS_FILE: path.join(repo, "secrets.env"),
		};
		/* So the heap flags below are the only ones in force. */
		delete env.NODE_OPTIONS;
		const r = spawnSync(
			process.execPath,
			[
				"--max-old-space-size=24",
				"--max-semi-space-size=1",
				"--require",
				preload,
				...args,
			],
			{ cwd: repo, env, encoding: "utf8" },
		);
		expect(r.status, r.stderr).toBe(0);
		return Number(fs.readFileSync(record, "utf8"));
	};

	it("reduces a 64 MB log within 32 MB above a tiny log's peak, where a whole read cannot", () => {
		const big = path.join(logs, "big.jsonl");
		const fd = fs.openSync(big, "w");
		const line = `${JSON.stringify(toolResult("x".repeat(16_000)))}\n`;
		for (let i = 0; i < 64e6 / line.length; i++) fs.writeSync(fd, line);
		fs.closeSync(fd);
		const small = path.join(logs, "small.jsonl");
		writeLog(small, [toolResult("x".repeat(16_000))]);

		const bound = 32_000;
		const floor = peakKb([SCRIPT, small]);
		expect(peakKb([SCRIPT, big]) - floor).toBeLessThan(bound);
		const whole = `require("fs").readFileSync(${JSON.stringify(big)}, "utf8").split("\\n").length`;
		expect(peakKb(["-e", whole]) - floor).toBeGreaterThan(bound);
	});
});
