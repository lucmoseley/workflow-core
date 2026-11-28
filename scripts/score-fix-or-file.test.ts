// @vitest-environment node

import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { readLabelRows, recordedScores, rates, report } = createRequire(
	__filename,
)("./lib/fix-or-file-rates.js");

const ROOT = path.resolve(__dirname, "..");
const LABELS = path.join(
	ROOT,
	"docs/data/fix-or-file-labels-2026-11-28/labels.jsonl",
);
const NATURAL = path.join(
	ROOT,
	"docs/data/fix-or-file-labels-2026-11-28/natural.jsonl",
);

const PRIVATE_REPOS = ["mantahostels", "health-and-fitness", "fantasy-books"];

// #5814
const PER_LABEL = { min: 30, max: 50 };

const scored = [
	{ id: "a", label: true, kind: "lost", p: 0.9 },
	{ id: "b", label: true, kind: "lost", p: 0.4 },
	{ id: "c", label: false, kind: "handled", p: 0.6 },
	{ id: "d", label: false, kind: "none", p: 0.1 },
	{ id: "e", label: null, kind: "natural", p: 0.7 },
	{ id: "f", label: null, kind: "natural", p: 0.2 },
];

describe("the fix-or-file scorer's rates (#5827)", () => {
	it("counts a reply at the threshold as a fire", () => {
		expect(rates(scored, 0.6)).toMatchObject({ fires: 3, tp: 1, fp: 1 });
	});

	it("reads TPR and TNR over judged replies only", () => {
		const r = rates(scored, 0.5);
		expect(r.tpr).toBe(0.5);
		expect(r.tnr).toBe(0.5);
	});

	it("leaves an unjudged fire out of the effective false-positive rate", () => {
		const r = rates(scored, 0.5);
		expect(r.unjudged).toBe(1);
		expect(r.effectiveFp).toBe(0.5);
	});

	it("reports no rate where nothing judged fired", () => {
		expect(rates(scored, 0.95)).toMatchObject({
			fires: 0,
			tpr: 0,
			effectiveFp: null,
		});
	});

	it("says how many replies of each label it scored", () => {
		expect(report(scored)[0]).toBe(
			"6 replies scored: 2 positive, 2 negative, 2 unjudged.",
		);
	});
});

describe("the committed fix-or-file data (#5827)", () => {
	it.each([LABELS, NATURAL])(
		"%s carries no reply text from a private repo",
		(file) => {
			const leaked = readLabelRows(file).filter(
				(r: { repo: string; text?: string }) =>
					PRIVATE_REPOS.includes(r.repo) && r.text !== undefined,
			);
			expect(leaked).toEqual([]);
		},
	);

	it("holds 30 to 50 examples of each label", () => {
		const labels = readLabelRows(LABELS).map(
			(r: { label: boolean | null }) => r.label,
		);
		for (const want of [true, false]) {
			const n = labels.filter((l: boolean | null) => l === want).length;
			expect(n).toBeGreaterThanOrEqual(PER_LABEL.min);
			expect(n).toBeLessThanOrEqual(PER_LABEL.max);
		}
	});

	it("reproduces the labelled set's published TNR from its recorded scores", () => {
		const s = recordedScores(readLabelRows(LABELS));
		expect(s).toHaveLength(93);
		expect(Math.round(rates(s, 0.5).tnr * 100)).toBe(82);
		expect(Math.round(rates(s, 0.7).tnr * 100)).toBe(96);
	});

	it("reproduces the natural sample's published effective false positives", () => {
		const s = recordedScores(readLabelRows(NATURAL));
		expect(s).toHaveLength(131);
		expect(
			[0.5, 0.6, 0.7].map((t) => Math.round(rates(s, t).effectiveFp * 100)),
		).toEqual([58, 56, 25]);
	});
});
