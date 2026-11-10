// @vitest-environment node
/*
 * lib/gate-judge-score.js: how measure-gate-judge.js counts a stored reply, a
 * labelled case over its runs and a corpus body's two readings (#4968). No
 * call is made: every reply here is written out.
 */

import { describe, expect, it } from "vitest";
import {
	compareReadings,
	judgeRow,
	quantile,
	scoreCase,
	wilson,
} from "./gate-judge-score.js";

const WAIT = "Re-measure once those records hold 500 ticks.";
const aWait = { sentence: WAIT, on: "data", window: "500 ticks" };

const row = (reading: unknown, fallback: string | null = null) => ({
	key: "k",
	ms: 7000,
	fallback,
	reading,
});
const found = row({
	waits: [{ ...aWait, basisNamesWindow: false }],
	bases: [],
});
const nothing = row({ waits: [], bases: [] });
const fellBack = row(null, "the judge did not answer within 55 s");

const basisCase = (label: string, basis: string, own = 12) => ({
	id: `${label}-1`,
	label,
	kind: "audit-window",
	own,
	text: `${WAIT}\n\n**Gate basis:** ${basis}\n`,
});
const classed = (basis: string, cls: string) =>
	row({
		waits: [{ ...aWait, basisNamesWindow: true }],
		bases: [{ basis, class: cls }],
	});

describe("a stored reply read against its body", () => {
	it("is nothing where the call fell back or the reply fits no schema", () => {
		expect(judgeRow(WAIT, null, fellBack)).toBeNull();
		expect(judgeRow(WAIT, null, row({ waits: "none" }))).toBeNull();
	});

	it("keeps a live quote, drops one in a fence, under the code's present checks", () => {
		expect(judgeRow(`${WAIT}\n`, null, found)).toMatchObject({
			replied: 1,
			dropped: 0,
			waits: [WAIT],
			added: [{ kind: "no-basis", text: WAIT, by: "model" }],
		});
		expect(judgeRow(`\`\`\`\n${WAIT}\n\`\`\`\n`, null, found)).toMatchObject({
			replied: 1,
			dropped: 1,
			waits: [],
			added: [],
		});
	});
});

describe("a case over its runs", () => {
	const waitCase = {
		id: "wait-1",
		label: "wait",
		kind: "corpus-wait",
		own: null,
		text: `${WAIT}\n`,
	};

	it("is flagged by the majority of the runs that replied", () => {
		expect(scoreCase(waitCase, [found, found, nothing])).toMatchObject({
			group: "wait",
			runs: 3,
			ran: 3,
			flags: 2,
			flagged: true,
			agree: false,
			patterns: false,
		});
		expect(scoreCase(waitCase, [found, nothing, nothing]).flagged).toBe(false);
	});

	it("agrees only where every run replied and all say the same", () => {
		expect(scoreCase(waitCase, [found, found, found]).agree).toBe(true);
		expect(scoreCase(waitCase, [found, found, fellBack])).toMatchObject({
			ran: 2,
			flagged: true,
			agree: false,
		});
		expect(scoreCase(waitCase, [fellBack, fellBack, fellBack])).toMatchObject({
			ran: 0,
			flagged: false,
			agree: false,
		});
	});

	it("counts a restated basis flagged only for its warrant", () => {
		const basis = "the ticket asks for 500 ticks.";
		const c = basisCase("restated", basis);
		expect(scoreCase(c, [classed(basis, "restated")]).flagged).toBe(true);
		expect(scoreCase(c, [classed(basis, "derived")]).flagged).toBe(false);
	});

	it("counts a derived basis flagged for any fault the reading raises", () => {
		const basis = "250 ticks a shift (#7), so 500 ticks is two shifts.";
		const c = basisCase("derived", basis);
		expect(scoreCase(c, [classed(basis, "derived")]).flagged).toBe(false);
		const unnamed = row({
			waits: [{ ...aWait, basisNamesWindow: false }],
			bases: [{ basis, class: "derived" }],
		});
		expect(scoreCase(c, [unnamed]).flagged).toBe(true);
	});

	it("groups an inherited basis naming no other issue apart, refused by rule", () => {
		const sourced = basisCase("inherited", "the 500 ticks #7 ruled on.");
		expect(scoreCase(sourced, []).group).toBe("inherited");
		const own = basisCase("inherited", "the 500 ticks #12 set out with.");
		const scored = scoreCase(own, [
			classed("the 500 ticks #12 set out with.", "inherited"),
		]);
		expect(scored).toMatchObject({
			group: "inherited-unsourced",
			flagged: true,
		});
	});
});

describe("a corpus body's two readings side by side", () => {
	const issue = { number: 12, state: "OPEN" };
	const PatternWait = "Read the counters a week after landing.";

	it("splits the waits into both, the judge's alone and the patterns' alone", () => {
		const body = `${PatternWait}\n\n${WAIT}\n\nCheck again 30 days after launch.\n`;
		const judged = judgeRow(
			body,
			12,
			row({
				waits: [
					{ ...aWait, basisNamesWindow: false },
					{
						sentence: PatternWait,
						on: "time",
						window: "a week",
						basisNamesWindow: false,
					},
				],
				bases: [],
			}),
		);
		if (!judged) throw new Error("the reply was not read");
		const lists = compareReadings(issue, body, judged);
		expect(lists.both).toBe(1);
		expect(lists.modelOnly).toEqual([`| #12 | OPEN | ${WAIT} | |`]);
		expect(lists.patternOnly).toHaveLength(1);
		expect(lists.patternOnly[0]).toContain("30 days after");
		expect(lists.bodyFlagged).toEqual([`| #12 | OPEN | no-basis: ${WAIT} | |`]);
	});

	it("lists a basis the judge would refuse with its class, and a body with no judge-only fault in no flagged list", () => {
		const basis = "the ticket asks for 500 ticks.";
		const body = `${WAIT}\n\n**Gate basis:** ${basis}\n`;
		const judged = judgeRow(body, 12, classed(basis, "restated"));
		if (!judged) throw new Error("the reply was not read");
		expect(compareReadings(issue, body, judged).basesFlagged).toEqual([
			`| #12 | OPEN | restated | no | ${basis} | |`,
		]);
		const clean = judgeRow(`${WAIT}\n`, 12, nothing);
		if (!clean) throw new Error("the reply was not read");
		expect(compareReadings(issue, `${WAIT}\n`, clean)).toMatchObject({
			basesFlagged: [],
			bodyFlagged: [],
		});
	});
});

describe("the interval and the quantile", () => {
	it("gives the Wilson 95% interval", () => {
		const [lo, hi] = wilson(8, 10);
		expect(lo).toBeCloseTo(0.49, 2);
		expect(hi).toBeCloseTo(0.943, 2);
		expect(wilson(0, 10)[0]).toBe(0);
		expect(wilson(10, 10)[1]).toBeCloseTo(1, 9);
		expect(wilson(0, 0)).toEqual([0, 1]);
	});

	it("reads a quantile off a sorted list, the last value at the top", () => {
		const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(quantile(sorted, 0.5)).toBe(6);
		expect(quantile(sorted, 0.99)).toBe(10);
		expect(quantile([], 0.5)).toBe(0);
	});
});
