// @vitest-environment node
/*
 * The shape of the gate judge's labelled set
 * (scripts/fixtures/gate-judge-cases.json, #4964), and that the judge's
 * prompt quotes none of it. The set is the judge's own test, run by hand
 * (`node scripts/measure-gate-judge.js validate`); breaking this lets a case
 * with no label or part drop out of the rates unseen, or a case leak into the
 * prompt it is meant to measure.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "./gate-judge.js";

const { cases }: { cases: Record<string, unknown>[] } = JSON.parse(
	fs.readFileSync(
		path.join(__dirname, "..", "fixtures", "gate-judge-cases.json"),
		"utf8",
	),
);
const LABELS = [
	"wait",
	"non-wait",
	"derived",
	"inherited",
	"restated",
	"asserted",
];
/* Shorter lines are markdown furniture any prompt may share. */
const MIN_LINE = 20;

describe("the labelled set", () => {
	it("gives every case a source issue, a label, a part and a text", () => {
		expect(cases.length).toBeGreaterThan(0);
		for (const c of cases) {
			expect(Number.isInteger(c.source), String(c.id)).toBe(true);
			expect(LABELS, String(c.id)).toContain(c.label);
			expect(["development", "held-out"], String(c.id)).toContain(c.part);
			expect(String(c.text ?? "").trim(), String(c.id)).not.toBe("");
		}
	});

	it("names each case once", () => {
		const ids = cases.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("holds both parts of every label that has more than its two audit cases", () => {
		for (const label of LABELS.filter((l) => l !== "asserted"))
			for (const part of ["development", "held-out"])
				expect(
					cases.some((c) => c.label === label && c.part === part),
					`${label} / ${part}`,
				).toBe(true);
	});

	it("appears nowhere in the prompt, whole or by the line", () => {
		const prompt = buildPrompt("");
		for (const c of cases) {
			const text = String(c.text);
			expect(prompt.includes(text), String(c.id)).toBe(false);
			for (const line of text.split("\n").map((l) => l.trim()))
				if (line.length >= MIN_LINE)
					expect(prompt.includes(line), `${c.id}: ${line}`).toBe(false);
		}
	});
});
