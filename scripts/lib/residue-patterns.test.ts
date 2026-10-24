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
	testFilesOnly?: boolean;
}

const { testFile, kinds }: { testFile: string; kinds: Kind[] } = JSON.parse(
	fs.readFileSync(path.join(__dirname, "residue-patterns.json"), "utf8"),
);

/** Each hit as `<line> <kind> <text>`, line 0 for a K8 ledger. */
function residueHits(text: string, file: string): string[] {
	const isTest = new RegExp(testFile).test(file);
	const hits: string[] = [];
	for (const k of kinds) {
		if (k.ledgerPattern && new RegExp(k.ledgerPattern).test(file))
			hits.push(`0 ${k.kind} ${file}`);
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
		["K7", "Rejected: a paid provider now."],
	])("%s fires on %j", (kind, line) => {
		expect(kindsHit(line)).toContain(kind);
	});

	it.each([
		"A new id sits above the high-water mark.",
		"Kill a background process as soon as nothing needs it.",
		"The fallback font stack is system-ui.",
		"The adversary's accusations, including those the pass turned down.",
	])("stays silent on the live line %j", (line) => {
		expect(kindsHit(line)).toEqual([]);
	});

	it("reads K5 in a test file only", () => {
		const line = 'it("keeps the retired flag out")';
		expect(kindsHit(line, "scripts/a.test.ts")).toContain("K5");
		expect(kindsHit(line, "scripts/a.js")).not.toContain("K5");
	});

	it("names a K8 ledger by its path alone", () => {
		expect(kindsHit("{}", "docs/doc-map-superseded.json")).toEqual(["K8"]);
		expect(kindsHit("{}", "docs/doc-map-restatements.json")).toEqual([]);
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
