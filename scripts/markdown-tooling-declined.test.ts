// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

const MARKDOWN_TOOLS = [
	"markdownlint-cli2",
	"markdownlint-cli",
	"markdownlint",
	"markdown-link-check",
	"prettier",
	"remark-lint",
	"remark-cli",
	"remark",
	"textlint",
	"mdformat",
	"lychee",
	"dprint",
];

const TOOL_PATTERN = new RegExp(MARKDOWN_TOOLS.join("|"));

describe("Markdown tooling is declined repo-wide (mantahostels#1540)", () => {
	it("declares no Markdown formatter, linter or link checker as a dependency", () => {
		const pkg = JSON.parse(read("package.json"));
		const deps = Object.keys({
			...(pkg.dependencies ?? {}),
			...(pkg.devDependencies ?? {}),
		});
		expect(deps.filter((d) => MARKDOWN_TOOLS.includes(d))).toEqual([]);
	});

	it("has no Markdown tool config, under any of its spellings", () => {
		const configs = fs
			.readdirSync(ROOT)
			.filter((f) =>
				/^\.?(markdownlint|remarkrc|remark\.config|prettierrc|prettier\.config|textlintrc|dprint|lychee)/i.test(
					f,
				),
			);
		expect(configs).toEqual([]);
		for (const f of [".prettierignore", ".lycheeignore"])
			expect(fs.existsSync(path.join(ROOT, f)), f).toBe(false);

		const pkg = JSON.parse(read("package.json"));
		for (const key of ["prettier", "remarkConfig", "markdownlint"])
			expect(Object.keys(pkg), key).not.toContain(key);
	});

	it("wires no npm script to a Markdown checker", () => {
		const pkg = JSON.parse(read("package.json"));
		for (const [name, cmd] of Object.entries(
			pkg.scripts as Record<string, string>,
		))
			expect(`${name} -> ${cmd}`, name).not.toMatch(TOOL_PATTERN);
	});

	it("runs no Markdown checker at either enforcement moment", () => {
		expect(read(".husky/pre-commit")).not.toMatch(TOOL_PATTERN);
		expect(read(".github/workflows/ci.yml")).not.toMatch(TOOL_PATTERN);
	});

	it("confirms Biome still cannot parse Markdown at all", () => {
		const schemaPath = path.join(
			ROOT,
			"node_modules",
			"@biomejs",
			"biome",
			"configuration_schema.json",
		);
		if (!fs.existsSync(schemaPath)) return;

		const keys = Object.keys(
			JSON.parse(fs.readFileSync(schemaPath, "utf8")).properties,
		);
		for (const known of ["javascript", "json", "css", "html"])
			expect(keys, `${known} is no longer a top-level language key`).toContain(
				known,
			);
		expect(keys).not.toContain("markdown");
	});

	it("records the decline in §W, where a reader meets it", () => {
		expect(read("docs/code-standards.md")).toMatch(
			/\*\*Markdown formatting, linting and link integrity — all three declined\*\*/,
		);
	});
});
