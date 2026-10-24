// @vitest-environment node
/*
 * write-back-routes.test.ts — ADR-0006's write-back routes stand in all three
 * shipped files that restate them (#1694). No adopter can open the ADR, so each
 * copy is the whole rule for the session reading it.
 *
 * DEPARTS FROM §X3, DELIBERATELY (§G4): the subject is the TEXT the three files
 * carry, so nothing is run end to end.
 *
 * Adding a route: add its row to ROUTES, then its words to every file until
 * this passes. Each row matches every copy's wording rather than one form,
 * because the injection sits at its byte cap (`node
 * scripts/check-context-budget.js`) and keeps the shortest one.
 *
 * Residual: a route the ADR or one file gains with no row here passes unseen —
 * the ADR's prose is too loose to match.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");

/* Each copy's passage runs from `start` to `end`, so a route phrase elsewhere
 * in the file cannot stand in for a dropped one. */
const COPIES = [
	{
		file: "scripts/inject-tracker-docs.sh",
		start: "A RESOLUTION THAT DISPOSES OF A FINDING",
		end: "Ruled at mantahostels#3205.",
	},
	{
		file: ".claude/skills/card-close/SKILL.md",
		start: "**Then write the closure back",
		end: "Carry whatever you edit",
	},
	{
		file: ".claude/skills/roadmap-edit/SKILL.md",
		start: "**Where this edit discharges",
		end: "Carry any edit",
	},
];

/* One row per ADR-0006 §1-3 route, the source class and its action together. */
const ROUTES = [
	{
		route: "an editable source is edited in place or deleted",
		pattern:
			/[Aa]n editable source has its declaring line edited in place or deleted/,
	},
	{
		route: "a generated source is written back at its generator's input",
		pattern:
			/(?:a generated|a `derived` or `generated-only`) one (?:is written back )?at its generator's input/,
	},
	{
		route: "an aged sidecar `role` declaration is cleared there",
		pattern:
			/aged (?:sidecar marker \()?`docs\/doc-map-classes\.json` `role`[^;]*? cleared there[;,]/,
	},
	{
		route: "a file that merely mentions the area takes nothing",
		pattern: /a file that merely mentions the area takes nothing/,
	},
];

/* Read through literal paths, so a change to any copy selects this file (base
 * §X10); the first case holds them to COPIES. */
const TEXTS = new Map(
	[
		"scripts/inject-tracker-docs.sh",
		".claude/skills/card-close/SKILL.md",
		".claude/skills/roadmap-edit/SKILL.md",
	].map((f) => [f, fs.readFileSync(path.join(ROOT, f), "utf8")]),
);

/** The passage, unescaped from the shell string and on one line. */
function passage(copy: (typeof COPIES)[number]): string {
	const text = TEXTS.get(copy.file) ?? "";
	const from = text.indexOf(copy.start);
	const to = text.indexOf(copy.end, from);
	if (from === -1 || to === -1) {
		throw new Error(
			`${copy.file}: passage anchors not found — moved, or reworded?`,
		);
	}
	return text.slice(from, to).replace(/\\`/g, "`").replace(/\s+/g, " ");
}

describe("ADR-0006's write-back routes (#1694)", () => {
	it("reads every copy COPIES names", () => {
		expect([...TEXTS.keys()]).toEqual(COPIES.map((c) => c.file));
	});

	for (const copy of COPIES) {
		it.each(ROUTES)(`${copy.file} states: $route`, ({ pattern }) => {
			expect(passage(copy)).toMatch(pattern);
		});
	}
});
