// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderSessionRules } from "./lib/adopter-skeleton.js";
import { MIRRORED_SECTIONS } from "./lib/machine-mirrored-rules.js";
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

describe("the working-pattern rules in the adopter session rules (#5294)", () => {
	it("hold the contract's two bullets, as it words them, and nothing else", () => {
		expect(adopterSection("Working patterns")).toEqual([
			toAdopter(readContractLine("- Queue actionable items at the moment")),
			toAdopter(readContractLine("- **Test a blocker before it ends a turn**")),
		]);
	});
});

const contractSection = (heading: string) =>
	(fs.readFileSync(CONTRACT, "utf8").split(`## ${heading}\n`)[1] ?? "")
		.split("\n## ")[0]
		.split("\n")
		.filter((l) => l.trim() && !l.startsWith("<!-- guard-registry"));

describe("the founder's working rules in the adopter session rules (#5344)", () => {
	const lines: Record<string, number> = {
		"Removal means gone": 1,
		"Leading practice": 2,
		"Reports and paid data": 2,
	};

	it("the pool meter leaves out exactly the sections the contract mirrors (#5683)", () => {
		expect(Object.keys(lines)).toEqual(MIRRORED_SECTIONS);
	});

	it.each(MIRRORED_SECTIONS)(
		"%s holds the contract's text, as it words it",
		(heading) => {
			const contract = contractSection(heading);
			expect(contract).toHaveLength(lines[heading] ?? -1);
			expect(adopterSection(heading).filter((l) => l.trim())).toEqual(
				contract.map(toAdopter),
			);
		},
	);

	it("the Leading practice text names no machine path", () => {
		expect(contractSection("Leading practice").join("\n")).not.toMatch(/~\//);
	});
});
