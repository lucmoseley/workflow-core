// @vitest-environment node
/*
 * guard-priced-options-round-check.test.ts — the under-researched-round limb
 * (#1710): a not-close round sent after fewer than `MIN_CALLS` tool calls
 * since the founder last spoke is refused once with `rule:house-decision`, and every
 * not-close question, or refused one the close-rivals limb then took, leaves a
 * line in the round-check log. Where the shape
 * limb is silent, the refusal names the question's shape faults and its
 * re-send is refused on them until fixed (#1730).
 *
 * The guard runs at every `Stop`: loosen a case and a round no research
 * preceded reaches the founder; break the record and a researched round is
 * refused for ever; break the log and #1691's reading (whether the limb
 * works) counts the wrong rounds.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sweptMarkers } from "./lib/arbiter-testkit";
import {
	EXEMPT_NAMES,
	LADDER,
	SHAPE_CAP,
	SHAPE_HELD_PASS,
	SHAPE_ONLY_PASS,
	SHAPE_TOO,
	STILL_WRONG,
	sessionCounters,
	withUnloadable,
} from "./lib/priced-options-testkit";
import { readRuleText } from "./lib/rule-text";
import { readStopGuardReason } from "./lib/stop-guard-testkit";
import {
	buildBashCall,
	failOpenLog,
	LATER,
	researchCalls,
	transcriptRecords,
	writeTranscript,
} from "./lib/transcript-testkit";

const GUARD = path.join(__dirname, "guard-priced-options.js");
const req = createRequire(__filename);
const { markersDir } = req("./lib/marker-root.js");
const { logPath } = req("./lib/refusal-log.js");
const {
	CLOSE_CHECK_LOG,
	CLOSE_RIVALS_PREFIX,
	CLOSE_RIVALS_RECORD_PREFIX,
	RESEARCH_LADDER_PREFIX,
	ROUND_CHECK_LOG,
	ROUND_CHECK_PREFIX,
	ROUND_CHECK_RECORD_PREFIX,
	SESSION_MAX,
	SESSION_PREFIX,
	SHAPE_PREFIX,
	limbOf,
} = req("./lib/priced-options-limbs.js");
const { readJsonl } = req("./lib/jev-log.js");
const { firstDrafts, MIN_CALLS } = req("./lib/round-check.js");

const { reset, founder, notification, buildSiblingBlock, stopFeedback } =
	transcriptRecords("2026-09-27T10:00:00Z");

let dir: string;
let file: string;
let config: string;
let sid: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "round-check-"));
	file = path.join(dir, "transcript.jsonl");
	config = path.join(dir, "config");
	sid = `round-check-${Math.random().toString(36).slice(2)}`;
	reset();
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const stop = (message: string) =>
	readStopGuardReason(GUARD, { dir, sid, message, transcript: file });

/* Unstamped: counted since the founder's message, never as following a
 * refusal, whose record carries the wall clock. */
const calls = (n: number) =>
	researchCalls(n).map((call) => JSON.stringify(call));
/* Stamped after any refusal a case has just made. */
const callAfter = (name = "Bash") =>
	JSON.stringify({
		...buildBashCall("ls", "t-after", {
			timestamp: new Date(Date.now() + LATER).toISOString(),
		}),
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id: "t-after", name, input: {} }],
		},
	});
const founderAfter = () =>
	JSON.stringify({
		type: "user",
		origin: { kind: "human" },
		timestamp: new Date(Date.now() + LATER).toISOString(),
		message: { role: "user", content: "go on" },
	});
const append = (...lines: string[]) =>
	fs.appendFileSync(file, `${lines.join("\n")}\n`);

const round = (n = 1, { close = false, relation = true } = {}) =>
	`❓ **Q${n}** — Which?\n\n${relation ? "Relation: rivals for one slot\n\n" : ""}` +
	`(A) option A\nConfidence: ${close ? "55% (45% - 65%)" : "80% (75% - 85%)"}. why\n\n` +
	`(B) option B\nConfidence: ${close ? "45% (35% - 55%)" : "20% (15% - 25%)"}. why\n\n` +
	"➡ (A).";

const UNDER = "before the session has researched it";
const RESENT = "re-sent with no tool call since this check refused it";
const CLOSE = "so the recommendation could flip";

const { counter, seed } = sessionCounters(() => ({ dir, sid }));
const readLog = () => readJsonl(logPath(dir, ROUND_CHECK_LOG))?.lines ?? [];
const line = (fields: Record<string, unknown>) => ({
	at: expect.any(String),
	session: sid,
	repo: path.basename(dir),
	round: "1",
	...fields,
});

describe("the threshold", () => {
	it("refuses a not-close round under the threshold with the rule:house-decision text", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS - 1));
		const reason = stop(round());
		expect(reason).toContain(UNDER);
		expect(reason).toContain(
			`Q1: ${MIN_CALLS - 1} tool calls since the founder last spoke, under the ${MIN_CALLS}`,
		);
		expect(reason).toContain(readRuleText("house-decision"));
	});

	it("passes one at the threshold", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS));
		expect(stop(round())).toBe("");
	});

	it("counts only since the founder's last message", () => {
		writeTranscript(file, founder(), ...calls(12), founder(), ...calls(2));
		expect(stop(round())).toContain("Q1: 2 tool calls");
	});

	it("leaves a message with no round alone", () => {
		writeTranscript(file, founder());
		expect(stop("Done.")).toBe("");
	});
});

describe("clearing", () => {
	beforeEach(() => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
	});

	it("passes the re-send once a tool call has run since the refusal", () => {
		append(callAfter());
		expect(stop(round())).toBe("");
	});

	it("refuses a re-send with no tool call since, again", () => {
		expect(stop(round())).toContain(RESENT);
		append(callAfter());
		expect(stop(round())).toBe("");
	});

	it("judges a new question afresh, on the founder's count", () => {
		append(callAfter());
		expect(stop(`${round()}\n\n${round(2)}`)).toContain("Q2: 4 tool calls");
	});

	it("drops the record once the founder speaks after it", () => {
		append(founderAfter(), ...calls(MIN_CALLS));
		expect(stop(round())).toBe("");
	});
});

describe("beside the close-rivals limb", () => {
	it("leaves a round both catch to the close-rivals limb's one refusal", () => {
		writeTranscript(file, founder(), ...calls(2));
		const reason = stop(round(1, { close: true }));
		expect(reason).toContain(CLOSE);
		expect(reason).not.toContain(UNDER);
		/* Still close, the re-send is the research-ladder limb's (#2006). */
		const resent = stop(round(1, { close: true }));
		expect(resent).toContain(LADDER);
		expect(resent).not.toContain(UNDER);
		expect(counter(ROUND_CHECK_PREFIX)).toBe(0);
		expect(readLog()).toEqual([]);
	});

	it("leaves a low-top round under the threshold to the close-rivals limb and its ladder (#2327, #2328)", () => {
		writeTranscript(file, founder(), ...calls(2));
		const lowTop =
			"❓ **Q1** — Which?\n\nRelation: independent, so any combination is takeable\n\n" +
			"(A) option A\nConfidence: 60% (50% - 70%). why\n\n" +
			"(B) option B\nConfidence: 30% (20% - 40%). why\n\n➡ (A).";
		const reason = stop(lowTop);
		expect(reason).toContain("so none is likely right");
		expect(reason).not.toContain(UNDER);
		const resent = stop(lowTop);
		expect(resent).toContain(LADDER);
		expect(resent).not.toContain(UNDER);
		expect(counter(ROUND_CHECK_PREFIX)).toBe(0);
		expect(readLog()).toEqual([]);
		expect(readJsonl(logPath(dir, CLOSE_CHECK_LOG))?.lines).toEqual([
			expect.objectContaining({ kind: "refused", trigger: "low-top" }),
			expect.objectContaining({ kind: "refused-ladder" }),
		]);
	});

	it("leaves a close-refused question re-priced apart to the close-rivals limb", () => {
		writeTranscript(file, founder(), ...calls(2));
		expect(stop(round(1, { close: true }))).toContain(CLOSE);
		append(callAfter());
		expect(stop(round())).toBe("");
	});

	it("pairs its refusal with the pass of a re-send the close-rivals limb took (#2076)", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		append(callAfter("Read"));
		expect(stop(round(1, { close: true }))).toContain(CLOSE);
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([
			line({ kind: "refused", callsBefore: 3, slot: 1 }),
			line({
				kind: "passed-after-refusal",
				callsBefore: 3,
				slot: 1,
				sinceRefusal: 1,
				tools: ["Read"],
				resent: true,
			}),
		]);
	});

	const resentLog = () => [
		line({ kind: "refused", callsBefore: 3, slot: 1 }),
		line({
			kind: "refused",
			callsBefore: 3,
			slot: 2,
			sinceRefusal: 0,
			tools: [],
		}),
	];
	const passedLog = () =>
		line({
			kind: "passed-after-refusal",
			callsBefore: 3,
			slot: 2,
			sinceRefusal: 1,
			tools: ["Read"],
			resent: true,
		});

	it("refuses a bare re-send re-priced close that the close-rivals limb, at its cap, passes (#2244)", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		seed(CLOSE_RIVALS_PREFIX, limbOf(CLOSE_RIVALS_PREFIX).cap);
		expect(stop(round(1, { close: true }))).toContain(RESENT);
		expect(readLog()).toEqual(resentLog());
		append(callAfter("Read"));
		expect(stop(round(1, { close: true }))).toBe("");
		expect(readLog()).toEqual([...resentLog(), passedLog()]);
	});

	it("refuses a bare re-send re-priced close that the close-rivals limb passes on an unreadable record (#2244)", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		fs.mkdirSync(
			path.join(markersDir(dir), `${CLOSE_RIVALS_RECORD_PREFIX}${sid}`),
			{ recursive: true },
		);
		expect(stop(round(1, { close: true }))).toContain(RESENT);
		expect(readLog()).toEqual(resentLog());
		append(callAfter("Read"));
		expect(stop(round(1, { close: true }))).toBe("");
		expect(readLog()).toEqual([...resentLog(), passedLog()]);
	});

	it("leaves a bare still-close re-send to the research ladder, and refuses it once the ladder's cap is spent (#2244)", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		expect(stop(round(1, { close: true }))).toContain(CLOSE);
		const laddered = stop(round(1, { close: true }));
		expect(laddered).toContain(LADDER);
		expect(laddered).not.toContain(RESENT);
		seed(RESEARCH_LADDER_PREFIX, limbOf(RESEARCH_LADDER_PREFIX).cap);
		expect(stop(round(1, { close: true }))).toContain(RESENT);
		expect(readLog()).toEqual(resentLog());
		append(callAfter("Read"));
		expect(stop(round(1, { close: true }))).toBe("");
		expect(readLog()).toEqual([...resentLog(), passedLog()]);
	});

	it("passes a bare re-send re-priced close at its own cap, logged as after its refusal (#2316)", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		seed(CLOSE_RIVALS_PREFIX, limbOf(CLOSE_RIVALS_PREFIX).cap);
		seed(ROUND_CHECK_PREFIX, limbOf(ROUND_CHECK_PREFIX).cap);
		expect(stop(round(1, { close: true }))).toBe("");
		expect(readLog().at(-1)).toEqual(
			line({
				kind: "passed-after-refusal",
				callsBefore: 3,
				slot: limbOf(ROUND_CHECK_PREFIX).cap,
				sinceRefusal: 0,
				tools: [],
				resent: true,
			}),
		);
	});

	it("refuses its own question in the same block as a close one", () => {
		writeTranscript(file, founder(), ...calls(2));
		const reason = stop(`${round(1, { close: true })}\n\n${round(2)}`);
		expect(reason).toContain(CLOSE);
		expect(reason).toContain("Q2: 2 tool calls");
	});
});

describe("cap and ceiling", () => {
	it("lets the fourth refusal through at its cap of 3", () => {
		writeTranscript(file, founder());
		for (const n of [1, 2, 3]) expect(stop(round(n))).toContain(UNDER);
		expect(counter(ROUND_CHECK_PREFIX)).toBe(3);
		expect(stop(round(4))).toBe("");
		expect(readLog().find((l: { round: string }) => l.round === "4")).toEqual(
			line({ round: "4", kind: "passed-at-cap", callsBefore: 0, slot: 3 }),
		);
	});

	it("promises no refusal of the re-send on the refusal that spends its cap (#1808)", () => {
		writeTranscript(file, founder(), ...calls(3));
		for (let i = 0; i < 2; i++)
			expect(stop(round())).toContain("a re-send with none is refused again");
		const last = stop(round());
		expect(last).toContain(UNDER);
		expect(last).not.toContain("refused again");
		expect(last).toContain(
			"This is this check's last refusal this session, so it will not refuse the re-send: research it before sending it.",
		);
	});

	it("lets a bare re-send through at the cap, logged as after its refusal", () => {
		writeTranscript(file, founder(), ...calls(3));
		for (let i = 0; i < 3; i++) expect(stop(round())).toContain(UNDER);
		expect(stop(round())).toBe("");
		expect(readLog().at(-1)).toEqual(
			line({
				kind: "passed-after-refusal",
				callsBefore: 3,
				slot: 3,
				sinceRefusal: 0,
				tools: [],
				resent: true,
			}),
		);
	});

	it("logs a question held past the spent cap at its first send's count (#1751)", () => {
		writeTranscript(file, founder());
		for (const n of [1, 2, 3]) expect(stop(round(n))).toContain(UNDER);
		expect(stop(`${round(4)}\n\n❓ **Q5** - **X**: pick one.`)).not.toBe("");
		append(...calls(12));
		expect(stop(round(4))).toBe("");
		expect(readLog().find((l: { round: string }) => l.round === "4")).toEqual(
			line({
				round: "4",
				kind: "passed-at-cap",
				callsBefore: 0,
				slot: 3,
				firstSent: expect.any(String),
			}),
		);
	});

	it.each([
		["will not parse", "{"],
		[
			"holds a question refused at no time",
			JSON.stringify({
				at: Date.now(),
				questions: [{ number: "1", callsBefore: 3, refusedAt: "then" }],
			}),
		],
	])("stands aside for a turn whose refusal record %s", (_name, text) => {
		fs.mkdirSync(markersDir(dir), { recursive: true });
		fs.writeFileSync(
			path.join(markersDir(dir), `${ROUND_CHECK_RECORD_PREFIX}${sid}`),
			text,
		);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([]);
		expect(failOpenLog(config)).toContain("limb skipped");
	});

	it("still refuses once the session ceiling is spent", () => {
		seed(SESSION_PREFIX, SESSION_MAX);
		writeTranscript(file, founder());
		const reason = stop(round());
		expect(reason).toContain(UNDER);
		expect(reason).not.toContain(SHAPE_TOO);
		expect(reason).toContain("checks may still block this session");
		for (const name of EXEMPT_NAMES) expect(reason).toContain(name);
		expect(counter(SESSION_PREFIX)).toBe(SESSION_MAX);
	});
});

const MISSHAPEN = "❓ **Q1** - **X**: pick one.";

describe("a misshapen round while the shape limb is silent (#1730)", () => {
	const lineFields = {
		callsBefore: 3,
		slot: 2,
		sinceRefusal: 1,
		tools: ["Bash"],
	};
	const misshapenRefused = () =>
		line({ kind: "refused-misshapen", ...lineFields });
	const fixedPassed = () =>
		line({ kind: "passed-after-refusal", ...lineFields, resent: true });

	it("names the shape fault in the under-researched refusal, past the spent ceiling", () => {
		seed(SESSION_PREFIX, SESSION_MAX);
		writeTranscript(file, founder(), ...calls(3));
		const reason = stop(MISSHAPEN);
		expect(reason).toContain(UNDER);
		expect(reason).toContain("Q1: 3 tool calls");
		expect(reason).toContain(SHAPE_TOO);
		expect(reason).toContain(SHAPE_HELD_PASS);
	});

	it("refuses the unchanged re-send after one tool call on its shape, then logs the fixed re-send passed after refusal", () => {
		seed(SESSION_PREFIX, SESSION_MAX);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(MISSHAPEN)).toContain(UNDER);
		append(callAfter());
		const reason = stop(MISSHAPEN);
		expect(reason).toContain(STILL_WRONG);
		expect(reason).toContain(SHAPE_ONLY_PASS);
		expect(reason).not.toContain(UNDER);
		expect(reason).not.toContain(readRuleText("house-decision"));
		expect(counter(ROUND_CHECK_PREFIX)).toBe(2);
		expect(readLog().at(-1)).toEqual(misshapenRefused());
		expect(stop(round())).toBe("");
		expect(readLog().at(-1)).toEqual(fixedPassed());
	});

	it("refuses a misshapen re-send re-priced close on its shape, after a tool call, where the close-rivals limb's cap is spent, then logs the fixed re-send passed after refusal (#2316)", () => {
		seed(SESSION_PREFIX, SESSION_MAX);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(MISSHAPEN)).toContain(UNDER);
		seed(CLOSE_RIVALS_PREFIX, limbOf(CLOSE_RIVALS_PREFIX).cap);
		append(callAfter());
		const reason = stop(round(1, { close: true, relation: false }));
		expect(reason).toContain(STILL_WRONG);
		expect(reason).not.toContain(UNDER);
		expect(readLog().at(-1)).toEqual(misshapenRefused());
		expect(stop(round(1, { close: true }))).toBe("");
		expect(readLog().at(-1)).toEqual(fixedPassed());
	});

	it("lists still-misshapen re-sends in record order, not message order, the close-judged one included (#2576)", () => {
		seed(SESSION_PREFIX, SESSION_MAX);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(`${MISSHAPEN}\n\n❓ **Q2** - **Y**: pick one.`)).toContain(
			UNDER,
		);
		seed(CLOSE_RIVALS_PREFIX, limbOf(CLOSE_RIVALS_PREFIX).cap);
		append(callAfter());
		const reason = stop(
			`${round(2, { close: true, relation: false })}\n\n${MISSHAPEN}`,
		);
		const q1 = reason.indexOf(STILL_WRONG);
		const q2 = reason.indexOf(STILL_WRONG.replace("Q1", "Q2"));
		expect(q1).toBeGreaterThan(-1);
		expect(q1).toBeLessThan(q2);
		expect(readLog().slice(-2)).toEqual([
			misshapenRefused(),
			{ ...misshapenRefused(), round: "2" },
		]);
	});

	it("holds the shape where the shape limb's own cap is spent and the ceiling is not", () => {
		seed(SHAPE_PREFIX, SHAPE_CAP);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(MISSHAPEN)).toContain(SHAPE_TOO);
		append(callAfter());
		expect(stop(MISSHAPEN)).toContain(STILL_WRONG);
	});

	it("holds the shape where the ceiling's last block is reserved from shape", () => {
		seed(SESSION_PREFIX, SESSION_MAX - 1);
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(MISSHAPEN)).toContain(SHAPE_TOO);
		expect(counter(SESSION_PREFIX)).toBe(SESSION_MAX - 1);
	});

	it("leaves the shape to the shape limb where that limb speaks", () => {
		writeTranscript(file, founder(), ...calls(3));
		const first = stop(MISSHAPEN);
		expect(first).toContain(UNDER);
		expect(first).not.toContain(SHAPE_TOO);
		expect(counter(SHAPE_PREFIX)).toBe(1);
		append(callAfter());
		expect(stop(MISSHAPEN)).not.toBe("");
		expect(counter(SHAPE_PREFIX)).toBe(2);
		expect(counter(ROUND_CHECK_PREFIX)).toBe(1);
	});
});

describe("the round-check log", () => {
	it("logs a refusal, a re-refusal and the pass after them", () => {
		writeTranscript(file, founder(), ...calls(3));
		stop(round());
		stop(round());
		append(callAfter("Read"));
		stop(round());
		expect(readLog()).toEqual([
			line({ kind: "refused", callsBefore: 3, slot: 1 }),
			line({
				kind: "refused",
				callsBefore: 3,
				slot: 2,
				sinceRefusal: 0,
				tools: [],
			}),
			line({
				kind: "passed-after-refusal",
				callsBefore: 3,
				slot: 2,
				sinceRefusal: 1,
				tools: ["Read"],
				resent: true,
			}),
		]);
	});

	it("logs a refused question the passing send left out", () => {
		writeTranscript(file, founder(), ...calls(3));
		stop(round());
		append(callAfter());
		expect(stop("Settled it from the config; acting on (A).")).toBe("");
		expect(readLog().at(-1)).toEqual(
			line({
				kind: "passed-after-refusal",
				callsBefore: 3,
				slot: 1,
				sinceRefusal: 1,
				tools: ["Bash"],
				resent: false,
			}),
		);
	});

	it("logs a round passed unrefused, and nothing while another limb blocks", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS));
		expect(stop(`${round()}\n\n❓ **Q2** - **X**: pick one.`)).not.toBe("");
		expect(readLog()).toEqual([]);
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([
			line({
				round: "2",
				kind: "passed-unrefused",
				callsBefore: MIN_CALLS,
				slot: 0,
				resent: false,
				firstSent: expect.any(String),
			}),
			line({
				kind: "passed-unrefused",
				callsBefore: MIN_CALLS,
				slot: 0,
				firstSent: expect.any(String),
			}),
		]);
	});

	it("logs a question another limb blocked first at its first send's count (#1751)", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS));
		expect(stop(`${round()}\n\n❓ **Q2** - **X**: pick one.`)).not.toBe("");
		append(...calls(3));
		expect(stop(round())).toBe("");
		expect(readLog()).toContainEqual(
			line({
				kind: "passed-unrefused",
				callsBefore: MIN_CALLS,
				slot: 0,
				firstSent: expect.any(String),
			}),
		);
	});

	it("counts a held question left out and a fresh one from one Stop as two first drafts (#1949)", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS));
		expect(stop(`${round()}\n\n❓ **Q2** - **X**: pick one.`)).not.toBe("");
		append(...calls(3));
		expect(stop(round(3))).toBe("");
		expect(new Set(readLog().map((l: { at: string }) => l.at)).size).toBe(1);
		expect([...firstDrafts(readLog()).values()]).toEqual([
			MIN_CALLS,
			MIN_CALLS + 3,
		]);
	});

	it("logs a held question, never refused, that the passing send left out (#1799)", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS));
		expect(stop(`${round()}\n\n❓ **Q2** - **X**: pick one.`)).not.toBe("");
		expect(stop("Settled it from the config; acting on (A).")).toBe("");
		expect(readLog()).toEqual([
			line({
				kind: "passed-unrefused",
				callsBefore: MIN_CALLS,
				slot: 0,
				resent: false,
				firstSent: expect.any(String),
			}),
			line({
				round: "2",
				kind: "passed-unrefused",
				callsBefore: MIN_CALLS,
				slot: 0,
				resent: false,
				firstSent: expect.any(String),
			}),
		]);
	});

	it("passes and logs a null count where the transcript cannot say", () => {
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([
			line({ kind: "passed-unrefused", callsBefore: null, slot: 0 }),
		]);
		expect(failOpenLog(config)).toContain("guard-priced-options round-check");
	});

	it("still passes a question, logging one fail-open line, when the log writer's library will not load (#1747)", () => {
		withUnloadable("refusal-log", () => {
			writeTranscript(file, founder(), ...calls(MIN_CALLS));
			expect(stop(round())).toBe("");
		});
		expect(
			failOpenLog(config).match(
				/log \.round-check-log\.jsonl would not be written/g,
			),
		).toHaveLength(1);
	});

	it("is named outside every swept marker family, apart from the close-check log", () => {
		expect(sweptMarkers([ROUND_CHECK_LOG])).toEqual([]);
		expect(ROUND_CHECK_LOG).not.toBe(CLOSE_CHECK_LOG);
	});
});

describe("a pass another Stop hook refuses (#1799)", () => {
	it("counts the re-send once, at its first draft's count", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS + 1));
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		append(...calls(3));
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([
			line({ kind: "passed-unrefused", callsBefore: MIN_CALLS + 1, slot: 0 }),
		]);
		expect([...firstDrafts(readLog()).values()]).toEqual([MIN_CALLS + 1]);
	});

	it("does not refuse again a question that passed after its refusal", () => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		append(callAfter());
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		expect(stop(round())).toBe("");
		expect(readLog().map((l: { kind: string }) => l.kind)).toEqual([
			"refused",
			"passed-after-refusal",
		]);
		expect(counter(ROUND_CHECK_PREFIX)).toBe(1);
	});

	it("still judges a new question the re-send adds", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS + 1));
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		expect(stop(`${round()}\n\n${round(2)}`)).toBe("");
		expect(readLog().map((l: { round: string }) => l.round)).toEqual([
			"1",
			"2",
		]);
	});

	it("keeps the pass through this guard's own block on the re-send", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS + 1));
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		expect(stop(`${round()}\n\n❓ **Q2** - **X**: pick one.`)).not.toBe("");
		append(stopFeedback());
		expect(stop(`${round()}\n\n${round(2)}`)).toBe("");
		expect(readLog().map((l: { round: string }) => l.round)).toEqual([
			"1",
			"2",
		]);
	});

	it("retires the pass where the transcript cannot say at the re-send", () => {
		writeTranscript(file, founder(), ...calls(MIN_CALLS + 1));
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		fs.rmSync(file);
		expect(stop(round())).toBe("");
		expect(readLog()).toEqual([
			line({ kind: "passed-unrefused", callsBefore: MIN_CALLS + 1, slot: 0 }),
			line({ kind: "passed-unrefused", callsBefore: null, slot: 0 }),
		]);
	});

	it.each([
		["the founder speaks", () => founder()],
		["a task notification wakes the session", () => notification()],
	])("judges a reused number afresh once %s", (_name, next) => {
		writeTranscript(file, founder(), ...calls(3));
		expect(stop(round())).toContain(UNDER);
		append(callAfter());
		expect(stop(round())).toBe("");
		append(buildSiblingBlock());
		append(next());
		expect(stop(round())).toContain(UNDER);
	});
});
