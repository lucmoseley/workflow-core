// @vitest-environment node
/*
 * lib/gate-judge.js's judgedBasisFaults, driven with a body and a fake in
 * place of the `claude` binary (lib/gate-judge-fake.ts), through the real
 * launcher (#4964).
 *
 * spawn-kept: a real fd (§X3) — the judge pipes its prompt to the launcher,
 * which hands the child its own stdin.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	JUDGE_BOUND_MS,
	judgedBasisFaults,
	LAUNCHER_GRACE_MS,
	readGateWrite,
} from "./gate-judge.js";
import {
	callLogPath,
	FALLBACK_LEAD,
	type JudgeFakePlan,
	MODEL_LEAD,
	OVERRIDE_LEAD,
	OVERRIDE_LINE,
	OVERRIDE_REASON,
	readJudgeCalls,
	writeJudgeFake,
} from "./gate-judge-fake";
import { basisFaults, basisRefusal } from "./issue-gate.js";
import { readJsonl } from "./jsonl.js";

/* Far over a faked call, which is three Node starts. */
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
	plan: JudgeFakePlan,
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
		WFC_CLAUDE_BIN: writeJudgeFake(path.join(dir, "claude"), log, plan),
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
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: WAIT, by: "model", on: "data" },
		]);
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
			{ kind: "unnamed-window", text: "500 ticks", by: "model", on: "data" },
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
				{ kind: "no-warrant", text: basis, by: "model", class: cls },
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
			{ kind: "no-warrant", text: basis, by: "model", class: "inherited" },
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
			{ kind: "no-warrant", text: basis, by: "model", class: "restated" },
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
		[
			"one that runs from prose into a fence",
			`Example:\n\n\`\`\`\n${WAIT}\n\`\`\`\n`,
			`Example:\n\n\`\`\`\n${WAIT}`,
		],
		[
			"one whose window sits in a code span",
			"A session may write `500 ticks` and see the gate refuse it.\n",
			"A session may write `500 ticks` and see the gate refuse it.",
		],
	])("%s", (_, body, quote) => {
		const r = judge(body, reading([wait(quote, "500 ticks")]));
		expect(r.faults).toEqual([]);
		expect(r.dropped).toBe(1);
		expect(r.fallback).toBeNull();
	});

	it("keeps a sentence that only ends on a code span", () => {
		const sentence = "Re-measure once 500 ticks are in `ticks.jsonl`";
		const r = judge(`${sentence}\n`, reading([wait(sentence, "500 ticks")]));
		expect(r.faults).toEqual([
			{ kind: "no-basis", text: sentence, by: "model", on: "data" },
		]);
		expect(r.dropped).toBe(0);
	});

	it("a basis quote two basis lines hold", () => {
		const r = judge(
			`${WAIT}\n\n**Gate basis:** the ticket asks for 500 ticks.\n\n**Gate basis:** the ticket asks for 500 ticks, twice over.\n`,
			reading(
				[wait(WAIT, "500 ticks", true)],
				[{ basis: "the ticket asks", class: "restated" }],
			),
		);
		expect(r.faults).toEqual([]);
		expect(r.dropped).toBe(1);
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
			{ kind: "no-basis", text: WAIT, by: "model", on: "data" },
		]);
	});
});

describe("a failed call leaves the pattern faults alone, with a reason", () => {
	const Body = `Read the counters a week after landing.\n\n${WAIT}\n`;
	const Patterns = [{ kind: "no-basis", text: "a week after", by: "patterns" }];

	it.each<[string, JudgeFakePlan, string]>([
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
		const r = judge(Body, { hang: true }, { boundMs: 500 });
		expect(r.faults).toEqual(Patterns);
		expect(r.fallback).toBe("the judge did not answer within 0.5 s");
	});

	it("the default bound and its grace end inside the guard's hook limit", () => {
		const hooks = JSON.parse(
			fs.readFileSync(
				path.join(__dirname, "..", "..", "hooks", "hooks.json"),
				"utf8",
			),
		);
		const limitMs = hooks.hooks.PreToolUse[0].hooks[0].timeout * 1000;
		expect(JUDGE_BOUND_MS + LAUNCHER_GRACE_MS).toBeLessThan(limitMs);
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
	const model = [{ kind: "no-basis", text: WAIT, by: "model", on: "data" }];

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
			{ kind: "no-basis", text: rewritten, by: "model", on: "data" },
		]);
	});

	it("that rewrites the wait around the window it had raises it", () => {
		const basis = "**Gate basis:** 12 ticks an hour (#7), so 90 ticks a shift.";
		const rewritten = "Hold the release until those records hold 500 ticks.";
		const r = judge(
			`${rewritten}\n\n${basis}\n`,
			reading([wait(rewritten, "500 ticks")]),
			{ before: `${WAIT}\n\n${basis}\n` },
		);
		expect(r.faults).toEqual([
			{ kind: "unnamed-window", text: "500 ticks", by: "model", on: "data" },
		]);
	});

	it("that brings a wait out of a fence raises it", () => {
		const r = judge(`${WAIT}\n`, reading([wait(WAIT, "500 ticks")]), {
			before: `\`\`\`\n${WAIT}\n\`\`\`\n`,
		});
		expect(r.faults).toEqual(model);
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
			{
				kind: "no-warrant",
				text: "the body sets 500 ticks.",
				by: "model",
				class: "restated",
			},
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

describe("a write route's reading", () => {
	const write = (
		body: string,
		plan: JudgeFakePlan,
		opts: { before?: string; own?: number; boundMs?: number } = {},
		extraEnv: Record<string, string> = {},
	) =>
		readGateWrite(body, {
			route: "file-issue",
			boundMs: BOUND_MS,
			...opts,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: path.join(dir, ".claude"),
				WFC_CLAUDE_CONFIG_A: path.join(dir, ".claude"),
				WFC_CLAUDE_BIN: writeJudgeFake(path.join(dir, "claude"), log, plan),
				WFC_GATE_JUDGE: "",
				...extraEnv,
			},
		});
	const Gate = "**Gated until:** 2026-10-05 — a week live";
	const PatternSays = [
		"with no `**Gate basis:**` line",
		"line does not name",
		"carries no warrant",
		"carry no warrant",
	];

	const Found = reading([wait(WAIT, "500 ticks")]);
	it("gives a model fault, a pattern fault, an override and a fallback text the review can count apart", () => {
		const model = write(`${WAIT}\n`, Found).refusal ?? "";
		const pattern = write(`${Gate}\n`, NOTHING).refusal ?? "";
		const fallback = write(`${WAIT}\n`, { exit: 1 }).advice;
		const override = write(`${WAIT}\n${OVERRIDE_LINE}\n`, Found).advice;
		const leads = {
			model: MODEL_LEAD,
			fallback: FALLBACK_LEAD,
			override: OVERRIDE_LEAD,
		};
		const texts = { model, pattern, fallback, override };
		for (const [name, text] of Object.entries(texts)) {
			for (const [lead, says] of Object.entries(leads))
				expect(text.includes(says), `${name} carries ${lead}`).toBe(
					lead === name,
				);
			expect(
				PatternSays.some((says) => text.includes(says)),
				`${name} carries a pattern fault`,
			).toBe(name === "pattern");
		}
		expect(pattern).toContain("as the wording patterns read it");
	});

	it("refuses a model fault, quoting it, naming its question, the template and the override", () => {
		const r = write(`Build it.\n\n${WAIT}\n`, Found);
		expect(r.advice).toBe("");
		const refusal = r.refusal ?? "";
		expect(refusal.startsWith(`${MODEL_LEAD}:`)).toBe(true);
		expect(refusal).toContain(`"${WAIT}" makes work wait on data accumulating`);
		expect(refusal).toContain("question 1:");
		expect(refusal).toContain("The line's template: `**Gate basis:**");
		expect(refusal).toContain(
			"write a live body line `**Gate judge override:** <why the reading is wrong>`",
		);
	});

	it("refuses a basis the model reads as asserted, naming question 2", () => {
		const r = write(
			`${WAIT}\n**Gate basis:** 500 ticks is plenty\n`,
			reading(
				[wait(WAIT, "500 ticks", true)],
				[{ basis: "500 ticks is plenty", class: "asserted" }],
			),
		);
		expect(r.refusal).toContain(
			'the basis "500 ticks is plenty" reads as asserted',
		);
		expect(r.refusal).toContain("question 2:");
	});

	it("refuses on both readings in one message, the pattern faults first", () => {
		const r = write(`${Gate}\n\n${WAIT}\n`, Found);
		expect(r.advice).toBe("");
		expect(
			r.refusal?.startsWith(
				`${basisRefusal(basisFaults(`${Gate}\n`), "the wording patterns")}\n\nIt also carries ${MODEL_LEAD}:`,
			),
		).toBe(true);
		expect(r.refusal).toContain(
			`"${WAIT}" makes work wait on data accumulating`,
		);
	});

	it("lets an override with a reason clear the model's faults, saying it was honoured", () => {
		const r = write(`${WAIT}\n${OVERRIDE_LINE}\n`, Found);
		expect(r.refusal).toBeNull();
		expect(r.advice).toContain(`${OVERRIDE_LEAD} ("${OVERRIDE_REASON}")`);
		expect(r.advice).toContain(
			`"${WAIT}" makes work wait on data accumulating`,
		);
	});

	it("clears nothing with an empty override, or one quoted in a fence", () => {
		const empty = write(`${WAIT}\n**Gate judge override:**\n`, Found);
		expect(empty.refusal).toContain(MODEL_LEAD);
		expect(empty.refusal).toContain("gives no reason, so it clears nothing");
		const fenced = write(
			`${WAIT}\n\n\`\`\`\n${OVERRIDE_LINE}\n\`\`\`\n`,
			Found,
		);
		expect(fenced.refusal).toContain(MODEL_LEAD);
		expect(fenced.advice).toBe("");
	});

	it("clears no pattern fault with an override", () => {
		const r = write(`${Gate}\n\n${WAIT}\n${OVERRIDE_LINE}\n`, Found);
		expect(r.refusal).toContain("as the wording patterns read it");
		expect(r.refusal).not.toContain(`It also carries ${MODEL_LEAD}`);
		expect(r.refusal).toContain(OVERRIDE_LEAD);
	});

	it("never refuses on a fallback, an override present or not", () => {
		for (const body of [`${WAIT}\n`, `${WAIT}\n**Gate judge override:**\n`]) {
			const r = write(body, { exit: 1 });
			expect(r.refusal).toBeNull();
			expect(r.advice).toContain(FALLBACK_LEAD);
		}
	});

	it("falls back without a call where too little of the bound is left", () => {
		const r = write(`${WAIT}\n`, reading([wait(WAIT, "500 ticks")]), {
			boundMs: 1000,
		});
		expect(r.advice).toContain(
			`${FALLBACK_LEAD} (too little of the hook's time was left for it)`,
		);
		expect(readJudgeCalls(log)).toEqual([]);
	});

	it("appends one record a call to the log", () => {
		fs.rmSync(callLogPath(), { force: true });
		write(`${WAIT}\n`, reading([wait(WAIT, "500 ticks")]), { own: 12 });
		write(`${WAIT}\n`, { exit: 3 });
		write(`${WAIT}\n${OVERRIDE_LINE}\n`, Found);
		expect(readJsonl(callLogPath())?.rows).toEqual([
			expect.objectContaining({
				route: "file-issue",
				issue: 12,
				patterns: [],
				model: [{ kind: "no-basis", text: WAIT, on: "data" }],
				fallback: null,
				override: null,
			}),
			expect.objectContaining({ model: [], fallback: "the judge exited 3" }),
			expect.objectContaining({ override: OVERRIDE_REASON }),
		]);
	});

	it("calls no model for an edit that changes nothing, nor with the judge off", () => {
		expect(write(`${WAIT}\n`, NOTHING, { before: `${WAIT}\n` })).toEqual({
			refusal: null,
			advice: "",
		});
		expect(write(`${Gate}\n`, NOTHING, {}, { WFC_GATE_JUDGE: "off" })).toEqual({
			refusal: basisRefusal(basisFaults(`${Gate}\n`), "the wording patterns"),
			advice: "",
		});
		expect(readJudgeCalls(log)).toEqual([]);
	});
});
