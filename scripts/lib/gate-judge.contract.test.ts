// @vitest-environment node
/*
 * Holds the gate judge's launch (#4964) to the installed harness's recording
 * (scripts/fixtures/gate-judge-reply.json, re-recorded by
 * `node scripts/record-gate-judge-reply.js`): the `result` row
 * lib/gate-judge.js reads, the row lib/gate-judge-fake.ts serves every suite
 * in its place, the flags lib/gate-judge-mode.js passes, and what a child
 * under those flags was seen to load and leave. Breaking it lets a renamed
 * result field or flag pass every suite while each live call falls back to
 * the patterns, and lets the child start loading tools, plugins or hooks, or
 * writing transcripts, unseen.
 *
 * Also holds the in-process `judge` fake (lib/gate-judge-fake.ts
 * `judgeServe`) to the fake launched through the real launcher, on every
 * plan but a hang. Breaking it lets the suites' module cases pass on a run
 * the launcher would never hand back.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgedBasisFaults, parseReading } from "./gate-judge.js";
import {
	buildReplyRow,
	type JudgeFakePlan,
	judgeServe,
	LAUNCHED_BOUND_MS,
	readJudgeCalls,
	recorded,
	writeJudgeFake,
} from "./gate-judge-fake";
import { JUDGE_ARGS } from "./gate-judge-mode.js";
import { recorded as headless } from "./headless-run-fake";

describe(`the judge mode's reply, in ${recorded.harness}'s recording`, () => {
	it("carries a reading that fits the schema, in the field the judge reads", () => {
		expect(recorded.result.type).toBe("result");
		expect(recorded.result.is_error).toBe(false);
		expect(parseReading(recorded.result.structured_output)).not.toBeNull();
	});

	it("quotes the recorded body's own words", () => {
		const reading = parseReading(recorded.result.structured_output);
		for (const w of reading?.waits ?? [])
			expect(recorded.body).toContain(w.sentence);
		for (const b of reading?.bases ?? [])
			expect(recorded.body).toContain(b.basis);
	});

	it("is the shape the fake serves", () => {
		const row = buildReplyRow({ waits: [], bases: [] });
		expect(Object.keys(row).sort()).toEqual(
			Object.keys(recorded.result).sort(),
		);
		expect(typeof row.result).toBe(typeof recorded.result.result);
	});
});

describe("the judge mode's flags", () => {
	it("are each an option the recorded harness lists", () => {
		const names = new Set(headless.options.flatMap((o) => o.names));
		for (const flag of JUDGE_ARGS.filter((a) => a.startsWith("-")))
			expect(names, flag).toContain(flag);
	});
});

describe("a child under the judge mode's flags was seen", () => {
	it("to load the answer tool alone: no MCP server, slash command or plugin", () => {
		expect(recorded.observed).toMatchObject({
			tools: ["StructuredOutput"],
			mcpServers: 0,
			slashCommands: 0,
			plugins: [],
		});
	});

	it("to fire no hook and leave no transcript", () => {
		expect(recorded.observed).toMatchObject({ hookEvents: 0, transcripts: 0 });
	});
});

describe("the in-process judge fake", () => {
	let dir = "";
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-judge-contract-"));
		fs.mkdirSync(path.join(dir, ".claude"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const Wait = "Re-measure once those records hold 500 ticks.";
	const Body = `Read the counters a week after landing.\n\n${Wait}\n`;

	it.each<[string, Exclude<JudgeFakePlan, { hang: true }>]>([
		[
			"a reading",
			{
				reading: {
					waits: [
						{
							sentence: Wait,
							on: "data",
							window: "500 ticks",
							basisNamesWindow: false,
						},
					],
					bases: [],
				},
			},
		],
		["a reply that is not JSON", { stdout: "Sorry, I cannot." }],
		["a non-zero exit", { exit: 3 }],
		[
			"a call the harness reports failed",
			{
				stdout: JSON.stringify({
					type: "result",
					is_error: true,
					result: "Usage limit reached",
				}),
			},
		],
	])(
		"reads alike to the launched fake on %s, sent the same prompt",
		(_, plan) => {
			const log = path.join(dir, "calls.jsonl");
			const env = {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
				WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
				WFC_CLAUDE_BIN: writeJudgeFake(path.join(dir, "claude"), log, plan),
			};
			const prompts: string[] = [];
			const { ms: _launchedMs, ...launched } = judgedBasisFaults(Body, {
				boundMs: LAUNCHED_BOUND_MS,
				env,
			});
			const { ms: _servedMs, ...served } = judgedBasisFaults(Body, {
				boundMs: LAUNCHED_BOUND_MS,
				env,
				judge: judgeServe(plan, prompts),
			});
			expect(served).toEqual(launched);
			expect(prompts).toEqual(readJudgeCalls(log).map((c) => c.stdin));
		},
	);
});
