// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const { rates, report } = createRequire(__filename)("./score-fix-or-file.js");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "docs", "data", "fix-or-file-labels-2026-11-28");

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

describe("the committed label set (#5827)", () => {
	const rows = (name: string) =>
		fs
			.readFileSync(path.join(DATA, name), "utf8")
			.split("\n")
			.filter((l) => l.trim())
			.map((l) => JSON.parse(l));

	it.each(["labels.jsonl", "natural.jsonl"])(
		"%s carries no reply text from a private repo",
		(name) => {
			const leaked = rows(name).filter(
				(r) =>
					["mantahostels", "health-and-fitness", "fantasy-books"].includes(
						r.repo,
					) && "text" in r,
			);
			expect(leaked).toEqual([]);
		},
	);

	it("holds 30 to 50 examples of each label", () => {
		const labels = rows("labels.jsonl").map((r) => r.label);
		const pos = labels.filter((l) => l === true).length;
		const neg = labels.filter((l) => l === false).length;
		expect(pos).toBeGreaterThanOrEqual(30);
		expect(pos).toBeLessThanOrEqual(50);
		expect(neg).toBeGreaterThanOrEqual(30);
		expect(neg).toBeLessThanOrEqual(50);
	});
});
