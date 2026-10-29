// @vitest-environment node
/*
 * Pins the census's strict patterns (#2153) and holds the adopter templates to
 * them (#2345). It reads the real templates init-adopter.js renders from, not
 * fixtures, so a residue line added to one fails here. Loosen a case and
 * residue ships into every adopter on its next bump.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface Kind {
	kind: string;
	pattern?: string;
	ledgerPattern?: string;
	keptFields?: string[];
	testFilesOnly?: boolean;
}

const { testFile, kinds }: { testFile: string; kinds: Kind[] } = JSON.parse(
	fs.readFileSync(path.join(__dirname, "residue-patterns.json"), "utf8"),
);

/** Each hit as `<line> <kind> <text>`, line 0 and the entry key for K8. */
function residueHits(text: string, file: string): string[] {
	const isTest = new RegExp(testFile).test(file);
	const hits: string[] = [];
	for (const k of kinds) {
		if (k.ledgerPattern && new RegExp(k.ledgerPattern).test(file)) {
			const kept = new Set(k.keptFields);
			const ledger: Record<string, object> = JSON.parse(text);
			for (const [key, entry] of Object.entries(ledger))
				if (Object.keys(entry).some((f) => !kept.has(f)))
					hits.push(`0 ${k.kind} ${key}`);
		}
		if (!k.pattern || (k.testFilesOnly && !isTest)) continue;
		const re = new RegExp(k.pattern);
		text.split("\n").forEach((l, i) => {
			if (re.test(l)) hits.push(`${i + 1} ${k.kind} ${l.trim()}`);
		});
	}
	return hits;
}

const kindsHit = (text: string, file = "docs/a.md") =>
	residueHits(text, file).map((h) => h.split(" ")[1]);

describe("the strict patterns", () => {
	it("name each kind K1-K8 with a pattern", () => {
		expect(kinds.map((k) => k.kind)).toEqual([
			"K1",
			"K2",
			"K3",
			"K4",
			"K5",
			"K6",
			"K7",
			"K8",
		]);
		for (const k of kinds) expect(k.pattern ?? k.ledgerPattern).toBeTruthy();
	});

	it.each([
		["K1", "and do not reinstate the old cap."],
		["K2", "<!-- was: 12 -->"],
		["K3", "a legacy alias for flavour"],
		["K4", "reads the legacy shape"],
		["K6", "the checkers that no longer fire at session start"],
		["K6", "the coverage authority since #1849"],
		["K7", "Rejected: a paid provider now."],
	])("%s fires on %j", (kind, line) => {
		expect(kindsHit(line)).toContain(kind);
	});

	it.each([
		"A new id sits above the high-water mark.",
		"Kill a background process as soon as nothing needs it.",
		"The fallback font stack is system-ui.",
		"The adversary's accusations, including those the pass turned down.",
		"It blocks since the hook reads stdin.",
	])("stays silent on the live line %j", (line) => {
		expect(kindsHit(line)).toEqual([]);
	});

	it("fires K6 on a repo-qualified `since <repo>#N` clause (#3356)", () => {
		expect(
			kindsHit("the coverage authority since mantahostels#1849"),
		).toContain("K6");
	});

	it("reads K5 in a test file only", () => {
		const line = 'it("keeps the retired flag out")';
		expect(kindsHit(line, "scripts/a.test.ts")).toContain("K5");
		expect(kindsHit(line, "scripts/a.js")).not.toContain("K5");
	});

	it("counts a K8 ledger entry only where it holds a narration field", () => {
		const ledger = JSON.stringify({
			cut: { needles: [{ needle: "82k" }], allowlist: [] },
			vocab: { phrases: ["old name"] },
			narrated: { needles: [], figure: "82k", retiredBy: "#9" },
		});
		expect(residueHits(ledger, "docs/doc-map-superseded.json")).toEqual([
			"0 K8 narrated",
		]);
		expect(kindsHit(ledger, "docs/doc-map-restatements.json")).toEqual([]);
	});

	it("is case-sensitive", () => {
		expect(kindsHit("LEGACY. NO LONGER. REJECTED: x")).toEqual([]);
	});
});

describe("the adopter templates", () => {
	it.each(fs.readdirSync(path.join(__dirname, "..", "templates", "adopter")))(
		"%s carries no residue",
		(name) => {
			const rel = `scripts/templates/adopter/${name}`;
			const text = fs.readFileSync(
				path.join(__dirname, "..", "templates", "adopter", `${name}`),
				"utf8",
			);
			expect(residueHits(text, rel)).toEqual([]);
		},
	);
});
