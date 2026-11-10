// @vitest-environment node
/*
 * lib/gate-judge.js's judgedBasisFaults, driven with a body and a stub in
 * place of the `claude` binary (lib/gate-judge-stub.ts), through the real
 * launcher (#4964).
 *
 * spawn-kept: a real fd (§X3) — the judge pipes its prompt to the launcher,
 * which hands the child its own stdin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { judgedBasisFaults } from "./gate-judge.js";
import {
	type JudgeStubPlan,
	readJudgeCalls,
	writeJudgeStub,
} from "./gate-judge-stub";

/* Far over a stubbed call, which is three Node starts. */
const BOUND_MS = 60_000;

let dir = "";
let log = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-judge-"));
	fs.mkdirSync(path.join(dir, ".claude"));
	log = path.join(dir, "calls.jsonl");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function judge(
	body: string,
	plan: JudgeStubPlan,
	opts: { own?: number; before?: string; boundMs?: number } = {},
	extraEnv: Record<string, string> = {},
) {
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
		CLAUDE_PROJECT_DIR: dir,
		WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
		WFC_CLAUDE_CONFIG_B: path.join(dir, ".claude2"),
		WFC_CLAUDE_CONFIG_C: path.join(dir, ".claude3"),
		WFC_CLAUDE_BIN: writeJudgeStub(path.join(dir, "claude"), log, plan),
		...extraEnv,
	};
	return judgedBasisFaults(body, { boundMs: BOUND_MS, ...opts, env });
}

const reading = (
	waits: Record<string, unknown>[] = [],
	bases: Record<string, unknown>[] = [],
) => ({ reading: { waits, bases } });

const wait = (sentence: string, window: string, basisNamesWindow = false) => ({
	sentence,
	on: "data",
	window,
	basisNamesWindow,
});

const WAIT = "Re-measure once those records hold 500 ticks.";
const NOTHING = reading();

describe("a judged wait", () => {
	it("in a body with no basis is a missing-basis fault, marked as the model's", () => {
		const r = judge(
			`Build it.\n\n${WAIT}\n`,
			reading([wait(WAIT, "500 ticks")]),
		);
		expect(r.faults).toEqual([{ kind: "no-basis", text: WAIT, by: "model" }]);
		expect(r.fallback).toBeNull();
	});

	it("whose window the basis does not name is an unnamed-window fault", () => {
		const body = `${WAIT}\n\n**Gate basis:** 12 ticks an hour (#7), so 90 ticks a shift.\n`;
		const r = judge(
			body,
			reading(
				[wait(WAIT, "500 ticks")],
				[
					{
						basis: "12 ticks an hour (#7), so 90 ticks a shift.",
						class: "derived",
					},
				],
			),
		);
		expect(r.faults).toEqual([
			{ kind: "unnamed-window", text: "500 ticks", by: "model" },
		]);
	});

	it("whose window the basis names raises nothing", () => {
		const body = `${WAIT}\n\n**Gate basis:** 500 ticks is two shifts at the 250 a shift #7 measured.\n`;
		const r = judge(
			body,
			reading(
				[wait(WAIT, "500 ticks", true)],
				[
					{
						basis: "500 ticks is two shifts at the 250 a shift #7 measured.",
						class: "derived",
					},
				],
			),
		);
		expect(r.faults).toEqual([]);
	});
});

describe("a judged basis", () => {
	const body = (basis: string) => `${WAIT}\n\n**Gate basis:** ${basis}\n`;
	const judged = (basis: string, cls: string, own?: number) =>
		judge(
			body(basis),
			reading([wait(WAIT, "500 ticks", true)], [{ basis, class: cls }]),
			{ own },
		).faults;

	it.each(["restated", "asserted"])(
		"classed %s is a no-warrant fault",
		(cls) => {
			const basis = "the ticket asks for 500 ticks.";
			expect(judged(basis, cls)).toEqual([
				{ kind: "no-warrant", text: basis, by: "model" },
			]);
		},
	);

	it("classed derived raises nothing", () => {
		expect(
			judged("250 ticks a shift (#7), so 500 is two shifts.", "derived"),
		).toEqual([]);
	});

	it("classed inherited raises nothing where it cites another issue", () => {
		expect(judged("the 500 ticks #7 ruled.", "inherited", 12)).toEqual([]);
	});

	it("classed inherited is a no-warrant fault where it cites only its own number", () => {
		const basis = "the 500 ticks #12 asks for.";
		expect(judged(basis, "inherited", 12)).toEqual([
			{ kind: "no-warrant", text: basis, by: "model" },
		]);
	});

	it("is quoted whole where the model quotes part of it, marker and all", () => {
		const basis = "the ticket asks for 500 ticks.";
		const r = judge(
			body(basis),
			reading(
				[wait(WAIT, "500 ticks", true)],
				[{ basis: "**Gate basis:** the ticket asks", class: "restated" }],
			),
		);
		expect(r.faults).toEqual([
			{ kind: "no-warrant", text: basis, by: "model" },
		]);
		expect(r.dropped).toBe(0);
	});
});

describe("a quote the body does not hold as its own words is dropped", () => {
	it.each([
		[
			"one that is no substring of the body",
			`Build it.\n\n${WAIT}\n`,
			`${WAIT} (a wait)`,
		],
		["one inside a fence", `Example:\n\n\`\`\`\n${WAIT}\n\`\`\`\n`, WAIT],
		["one inside a code span", `Write \`${WAIT}\` to see it refused.\n`, WAIT],
	])("%s", (_, body, quote) => {
		const r = judge(body, reading([wait(quote, "500 ticks")]));
		expect(r.faults).toEqual([]);
		expect(r.dropped).toBe(1);
		expect(r.fallback).toBeNull();
	});

	it("a basis no live basis line holds", () => {
		const r = judge(
			`${WAIT}\n\n**Gate basis:** 250 ticks a shift (#7), so 500 is two shifts.\n`,
			reading(
				[wait(WAIT, "500 ticks", true)],
				[{ basis: "a round figure", class: "asserted" }],
			),
		);
		expect(r.faults).toEqual([]);
		expect(r.dropped).toBe(1);
	});
});

describe("the patterns stay the floor", () => {
	const PatternWait = "Read the counters a week after landing.";

	it("a pattern fault stands when the model finds nothing", () => {
		const r = judge(PatternWait, NOTHING);
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: "a week after", by: "patterns" },
		]);
		expect(r.fallback).toBeNull();
	});

	it("a wait both readings find is raised once, as the patterns'", () => {
		const r = judge(PatternWait, reading([wait(PatternWait, "a week")]));
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: "a week after", by: "patterns" },
		]);
	});

	it("carries the model's faults beside the patterns'", () => {
		const r = judge(
			`${PatternWait}\n\n${WAIT}\n`,
			reading([wait(WAIT, "500 ticks")]),
		);
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: "a week after", by: "patterns" },
			{ kind: "no-basis", text: WAIT, by: "model" },
		]);
	});
});

describe("a failed call leaves the pattern faults alone, with a reason", () => {
	const Body = `Read the counters a week after landing.\n\n${WAIT}\n`;
	const Patterns = [{ kind: "no-basis", text: "a week after", by: "patterns" }];

	it.each<[string, JudgeStubPlan, string]>([
		["a non-zero exit", { exit: 3 }, "the judge exited 3"],
		[
			"a reply that is not JSON",
			{ stdout: "Sorry, I cannot." },
			"was not JSON",
		],
		[
			"a reply that fails the schema",
			{ reading: { waits: [{ sentence: WAIT, on: "a hunch" }], bases: [] } },
			"did not fit its schema",
		],
		[
			"a reply with no reading",
			{ stdout: JSON.stringify({ type: "result" }) },
			"did not fit its schema",
		],
		[
			"a call the harness reports failed",
			{
				stdout: JSON.stringify({
					type: "result",
					is_error: true,
					result: "Usage limit reached",
				}),
			},
			"the judge's call failed: Usage limit reached",
		],
	])("%s", (_, plan, why) => {
		const r = judge(Body, plan);
		expect(r.faults).toEqual(Patterns);
		expect(r.fallback).toContain(why);
		expect(r.reading).toBeNull();
	});

	it("a hang past the bound", () => {
		const r = judge(Body, { hang: true }, { boundMs: 1500 });
		expect(r.faults).toEqual(Patterns);
		expect(r.fallback).toBe("the judge did not answer within 1.5 s");
		expect(r.ms).toBeLessThan(1500 + 5000);
	});

	it("a launch that would not bill the subscription, launching nothing", () => {
		const r = judge(
			Body,
			reading([wait(WAIT, "500 ticks")]),
			{},
			{ ANTHROPIC_API_KEY: "k" },
		);
		expect(r.faults).toEqual(Patterns);
		expect(r.fallback).toContain("the launch was refused");
		expect(r.fallback).toContain("ANTHROPIC_API_KEY is set");
		expect(readJudgeCalls(log)).toEqual([]);
	});
});

describe("an edit", () => {
	const Old = `Some context.\n\n${WAIT}\n`;
	const model = [{ kind: "no-basis", text: WAIT, by: "model" }];

	it("that leaves a judged wait untouched raises nothing for it", () => {
		const r = judge(
			`Some new context.\n\n${WAIT}\n`,
			reading([wait(WAIT, "500 ticks")]),
			{
				before: Old,
			},
		);
		expect(r.faults).toEqual([]);
	});

	it("that rewrites the wait raises it", () => {
		const rewritten = "Re-measure once those records hold 900 ticks.";
		const r = judge(
			`Some context.\n\n${rewritten}\n`,
			reading([wait(rewritten, "900 ticks")]),
			{ before: Old },
		);
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: rewritten, by: "model" },
		]);
	});

	it("that rewrites a basis raises it, and holds one left as it was", () => {
		const before = `${WAIT}\n\n**Gate basis:** the ticket asks for 500 ticks.\n`;
		const cls = (basis: string) =>
			reading([wait(WAIT, "500 ticks", true)], [{ basis, class: "restated" }]);
		expect(
			judge(`Edited.\n\n${before}`, cls("the ticket asks for 500 ticks."), {
				before,
			}).faults,
		).toEqual([]);
		const after = `${WAIT}\n\n**Gate basis:** the body sets 500 ticks.\n`;
		expect(
			judge(after, cls("the body sets 500 ticks."), { before }).faults,
		).toEqual([
			{ kind: "no-warrant", text: "the body sets 500 ticks.", by: "model" },
		]);
	});

	it("never sends the body before it to the model", () => {
		judge("The new body.\n", NOTHING, { before: "The old body, kept back.\n" });
		const [call] = readJudgeCalls(log);
		expect(call?.stdin).toContain("The new body.");
		expect(call?.stdin).not.toContain("kept back");
	});

	it("with no body before it is judged whole", () => {
		expect(judge(Old, reading([wait(WAIT, "500 ticks")])).faults).toEqual(
			model,
		);
	});
});
