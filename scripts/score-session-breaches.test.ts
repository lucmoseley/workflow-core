// @vitest-environment node
/*
 * The before/after test's score (#2042), run as the command: over a recorded
 * transcript, trimmed from a real session to its refusal,
 * deny and message records; and over hand-built records in the same shapes
 * (`docs/research/startup-load-before-after-test.md` F2) for the edges the
 * recording does not reach. Plus the pre-registration's completeness: every
 * Stop guard registered today is classed. A break here mis-scores every arm
 * of the test, and its rate ratio with it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const { registeredGuards } = require("./lib/guard-fires.js");
const { hooksAt, mergeHooks } = require("./lib/core-hooks.js");
const { STOP_CLASS } = require("./lib/breach-score-rule.js");

const ROOT = path.resolve(__dirname, "..");
const cliPath = path.join(ROOT, "scripts", "score-session-breaches.js");

/** A Stop refusal as the harness records it: the attachment, plus the user copy the scorer must not count. */
const stopBlock = (guard: string, toolUseID: string, text: string) => [
	{
		type: "attachment",
		uuid: `a-${toolUseID}-${guard}`,
		isSidechain: false,
		timestamp: "2026-10-18T05:16:37.242Z",
		attachment: {
			type: "hook_blocking_error",
			hookName: "Stop",
			hookEvent: "Stop",
			toolUseID,
			blockingError: {
				blockingError: text,
				command: `command -v node >/dev/null && node "$CLAUDE_PROJECT_DIR"/scripts/${guard}`,
			},
		},
	},
	{
		type: "user",
		uuid: `u-${toolUseID}-${guard}`,
		isSidechain: false,
		message: { role: "user", content: `Stop hook feedback:\n${text}` },
	},
];

const deny = (toolUseId: string, text: string, isSidechain = false) => ({
	type: "user",
	uuid: `d-${toolUseId}`,
	isSidechain,
	message: {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: toolUseId,
				is_error: true,
				content: `PreToolUse:Bash hook error: ${text}`,
			},
		],
	},
});

const assistant = (id: string) => ({
	type: "assistant",
	uuid: `m-${id}`,
	isSidechain: false,
	version: "2.1.302",
	message: { id, role: "assistant", content: [{ type: "text", text: "." }] },
});

const JOB_DIR_DENY =
	"Refused: this writes a file straight into the job directory's own tmp folder — $CLAUDE_JOB_DIR/tmp/x.md";
const SUITE_CAP_DENY =
	"This would be suite 4, which is past the last rung anything has ever been measured on. Wait for one to finish";

describe("the score, run as a command", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "breach-score-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const write = (name: string, records: unknown[]) =>
		fs.writeFileSync(
			path.join(dir, name),
			`${records.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	const run = (args: string[]) => {
		const r = runInProcess(cliPath, args, { cwd: ROOT });
		return { out: r.stdout, err: r.stderr, code: r.status };
	};
	const scoreOf = (args: string[]) => JSON.parse(run([...args, "--json"]).out);

	it("scores a recorded session as its refusals read", () => {
		const recorded = path.join(
			ROOT,
			"scripts",
			"fixtures",
			"session-breaches",
			"recorded-05970a71.jsonl",
		);
		const [s] = scoreOf(["--file", recorded]);
		expect(s.score).toBe(5);
		expect(s.stop).toEqual({
			"guard-priced-options.js": 1,
			"guard-unpushed-commits.js": 1,
			"guard-uncommitted-work.js": 1,
			"guard-inventory.js": 1,
		});
		expect(s.deny).toEqual({ "guard-job-dir-scratch.sh": 1 });
		expect(s.notice).toEqual({ "guard-session-ceiling.js": 1 });
		expect(s.families).toEqual({
			inventory: 1,
			jobDir: 1,
			concision: 1,
			environment: 1,
		});
		expect(s.assistantMessages).toBe(90);
	});

	it("counts breach-class refusals and denies, and nothing it does not score", () => {
		write("s1.jsonl", [
			assistant("m1"),
			assistant("m1"),
			...stopBlock("guard-inventory.js", "t1", "Inventory owed."),
			...stopBlock("guard-priced-options.js", "t2", "Price the options."),
			...stopBlock("guard-session-ceiling.js", "t3", "Long session."),
			...stopBlock("guard-lost-deny.js", "t4", "A deny failed open."),
			...stopBlock("guard-automode-refusal.js", "t5", "Classifier."),
			...stopBlock("concision-backstop.sh stop", "t6", "Review owed."),
			deny("toolu_1", JOB_DIR_DENY),
			deny("toolu_2", SUITE_CAP_DENY),
			assistant("m2"),
		]);
		const [s] = scoreOf(["--dir", dir]);
		expect(s.score).toBe(3);
		expect(s.stop).toEqual({
			"guard-inventory.js": 1,
			"guard-priced-options.js": 1,
		});
		expect(s.families).toEqual({
			inventory: 1,
			jobDir: 1,
			concision: 1,
			environment: 1,
		});
		expect(Object.keys(s.notice).sort()).toEqual([
			"guard-automode-refusal.js",
			"guard-lost-deny.js",
			"guard-session-ceiling.js",
		]);
		expect(s.assistantMessages).toBe(2);
		expect(s.versions).toEqual(["2.1.302"]);
	});

	it("counts a duplicated attachment record, or a deny's repeat, once", () => {
		const block = stopBlock("guard-unpushed-commits.js", "t1", "Unpushed.");
		write("s1.jsonl", [
			...block,
			{ ...block[0], uuid: "a-copy" },
			deny("toolu_1", "Refused: anything."),
			deny("toolu_1", "Refused: anything."),
		]);
		expect(scoreOf(["--dir", dir])[0].score).toBe(2);
	});

	it("reads the main transcript only, never a subagent's", () => {
		write("s1.jsonl", [
			deny("toolu_1", "Refused: main."),
			deny("toolu_2", "Refused: inline sidechain.", true),
		]);
		fs.mkdirSync(path.join(dir, "s1", "subagents"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "s1", "subagents", "agent-1.jsonl"),
			`${JSON.stringify(deny("toolu_3", "Refused: subagent.", true))}\n`,
		);
		const sessions = scoreOf(["--dir", dir]);
		expect(sessions.map((s: { session: string }) => s.session)).toEqual(["s1"]);
		expect(sessions[0].score).toBe(1);
	});

	it("is no deny where the error is the tool's own, not a hook's", () => {
		write("s1.jsonl", [
			{
				type: "user",
				uuid: "u1",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu_1",
							is_error: true,
							content: "Exit code 1\nnpm ERR!",
						},
					],
				},
			},
		]);
		expect(scoreOf(["--dir", dir])[0].score).toBe(0);
	});

	it("stops on a Stop guard the rule has not classed", () => {
		write("s1.jsonl", stopBlock("guard-new-thing.js", "t1", "New."));
		const r = run(["--file", path.join(dir, "s1.jsonl")]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("guard-new-thing.js");
		expect(r.err).toContain("Class each in STOP_CLASS");
		expect(r.err).toContain("scripts/lib/breach-score-rule.js");
	});

	it("says an unreadable directory out loud", () => {
		const absent = path.join(dir, "absent");
		const r = run(["--dir", absent]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(
			`${absent} cannot be read as a transcript directory`,
		);
	});
});

describe("the pre-registered classes", () => {
	it("class every Stop guard this repo and its plugin register", () => {
		const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
		const stops = registeredGuards(
			mergeHooks([
				{ settings: { hooks: hooksAt(ROOT, "self-plugin/hooks/hooks.json") } },
				{ settings: read(path.join(ROOT, "hooks", "hooks.json")) },
			]),
		)
			.filter((r: { event: string }) => r.event === "Stop")
			.map((r: { key: string }) => r.key.split(" ")[0]);
		expect(stops.filter((g: string) => !STOP_CLASS[g])).toEqual([]);
	});
});
