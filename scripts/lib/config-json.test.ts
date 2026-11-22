// @vitest-environment node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatConfigJson } from "./config-json.js";

const BIOME = path.resolve(__dirname, "..", "..", "node_modules/.bin/biome");

const biome = (text: string) =>
	execFileSync(
		BIOME,
		["format", "--indent-style=tab", "--stdin-file-path=config.json"],
		{ input: text, encoding: "utf8" },
	);

const fill = (n: number) => "a".repeat(n - 2 - 6 - 2 - 2);

const CASES: Record<string, unknown> = {
	"an adopter config after an upgrade": {
		contract: 1,
		modules: ["roadmap", "governance", "site"],
		manualRender: {
			command: "npm run gen:doc-pages",
			outputs: ["docs/pages/operating-manual.html", "docs/pages/index.html"],
		},
		alwaysLoaded: [
			"CLAUDE.md",
			"AGENTS.md",
			"docs/working-contract.md",
			".claude/output-styles/manta-voice.md",
			".claude/workflow-core.md",
		],
		disabled: ["guard-vitest-wrapper.sh"],
		stepsOwed: [{ tag: "v1.2.0", type: "act", text: "Re-copy it." }],
		walkedTo: "v1.3.0",
	},
	"arrays at the width boundary, with and without the trailing comma": {
		k: [fill(80)],
		l: [`${fill(80)}b`],
		m: [fill(81)],
	},
	"empties, nesting and mixed scalars": {
		e: {},
		ea: [],
		inEmpty: [{}, []],
		nested: [[1, 2], [3]],
		deep: [["a", { k: 1 }]],
		mixed: [1, "a", true, null, -2.5],
	},
	"a breaking all-number array fills": {
		nums: Array.from({ length: 60 }, (_, i) => i * 7),
	},
	"a breaking string array goes one per line": {
		words: Array.from({ length: 8 }, (_, i) => `word-number-${i}`),
	},
};

describe("formatConfigJson", () => {
	for (const [name, value] of Object.entries(CASES))
		it(`prints what Biome keeps: ${name}`, () => {
			const text = formatConfigJson(value);
			expect(JSON.parse(text)).toEqual(value);
			expect(biome(text)).toBe(text);
		});

	it("keeps a short array on the line its key starts", () => {
		expect(formatConfigJson({ modules: ["roadmap", "site"] })).toBe(
			'{\n\t"modules": ["roadmap", "site"]\n}\n',
		);
	});
});
