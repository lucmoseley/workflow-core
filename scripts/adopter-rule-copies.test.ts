// @vitest-environment node
/*
 * The working contract's rules that every adopter session needs are written
 * twice: in docs/working-contract.md, and in the adopter session-rules
 * template, rendered into each adopter's `.claude/workflow-core.md`. Each
 * adopter bullet must equal the contract's under five rewrites: the founder's
 * name, the `rule:house-decision` fragment's gloss for the contract's glossary
 * pointer (the glossary does not ship), the bare guard name the template
 * spells guards by, a `node`/`bash`/`sh`/`python3 scripts/` command spelled at the plugin root as
 * the renderer spells it (#2005), and no core issue cites, which would resolve
 * against the adopter's own tracker (#1709, which wrote the house rules into the
 * template; #1739, whose review gave the copies this file).
 *
 * The adopter's house-decision bullet stops before the contract's
 * `**Enforced**` tail, which the guard prints when it bites (#2035).
 *
 * Loosen a case and a rule reworded in one copy leaves every adopter session
 * working to the old words, unseen until someone reads both.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSessionRules } from "./lib/adopter-skeleton.js";
import { readRuleText } from "./lib/rule-text";

const ROOT = path.resolve(__dirname, "..");
const CONTRACT = path.join(ROOT, "docs", "working-contract.md");
const FOUNDER = "A Founder";

const readContractLine = (lead: string) => {
	const line = fs
		.readFileSync(CONTRACT, "utf8")
		.split("\n")
		.find((l) => l.startsWith(lead));
	if (!line) throw new Error(`the working contract's "${lead}" rule is gone`);
	return line;
};

const gloss = (readRuleText("house-decision").split("\n")[0] ?? "")
	.replace(/^.*?HOUSE DECISION \(#\d+\) — /, "")
	.replace("only he holds", `only ${FOUNDER} holds`)
	.replace(/\.$/, "");

const toAdopter = (line: string) =>
	line
		.replace("the founder", FOUNDER)
		.replace("(`GLOSSARY.md`)", `(${gloss})`)
		.replace("`scripts/guard-priced-options.js`", "`guard-priced-options.js`")
		.replace(/\b(node|bash|sh|python3) scripts\//g, `$1 ${ROOT}/scripts/`)
		.replace(/ \(#\d+\)/g, "");

const rendered = renderSessionRules({
	modules: [],
	founder: FOUNDER,
	pluginRoot: ROOT,
	ciCheck: null,
});

const adopterSection = (heading: string) =>
	(rendered.split(`## ${heading}\n`)[1]?.split("\n## ")[0] ?? "")
		.trim()
		.split("\n");

describe("the house rules in the adopter session rules (#1709)", () => {
	const bullets = adopterSection(`Questions to ${FOUNDER}`);

	it("carries the house-decision rule as the contract words it, glossed for the adopter", () => {
		expect(gloss).toMatch(/^a choice research cannot make, .* measured$/);
		expect(bullets[0]).toBe(
			toAdopter(
				readContractLine(
					"- **Only a house decision reaches the founder",
				).replace(/ \*\*Enforced\*\*.*$/, ""),
			),
		);
	});

	it("carries the house-value rule as the contract words it", () => {
		expect(bullets[1]).toBe(
			toAdopter(
				readContractLine("- **A value called house is unsourced until traced"),
			),
		);
	});

	it("holds those two bullets and nothing else", () => {
		expect(bullets).toHaveLength(2);
	});
});

describe("the rendered adopter session rules", () => {
	it("leave no placeholder unfilled in any section", () => {
		expect(rendered).not.toContain("{{");
	});
});

describe("the durable-fix rule in the adopter session rules (#1739)", () => {
	it("holds the contract's bullet and nothing else", () => {
		expect(adopterSection("Building for the long term")).toEqual([
			toAdopter(readContractLine("- **Build for the repo's long-term health")),
		]);
	});
});
