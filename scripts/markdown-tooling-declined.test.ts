// @vitest-environment node

/*
 * markdown-tooling-declined.test.ts — Markdown formatting, linting and link
 * checking were declined, not forgotten (mantahostels#1540, under map mantahostels#1131).
 *
 * 226 tracked `.md` files are touched by no formatter and no linter. That is
 * deliberate on three separate measurements, which mantahostels#1540 holds and
 * `docs/code-standards.md` §W summarises; this file pins only that the tools
 * really are wired nowhere.
 *
 * It reads the real `package.json`, `.husky/pre-commit` and
 * `.github/workflows/ci.yml` rather than fixtures, since the claim is about
 * this repo's own wiring.
 *
 * These cases exist so a later ticket wanting any of the three has to delete
 * them and say why, rather than reintroducing it from first principles.
 * Loosen one and a Markdown tool can land in a hook or CI unremarked.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

/*
 * Package names, not a free regex: `prettier` must not match `prettier-ignore`
 * inside an unrelated dependency's name. Every entry is a real npm package that
 * formats, lints or link-checks Markdown. `lychee` and `markdown-link-check`
 * are here because link integrity is one of the three legs mantahostels#1540 declined, and
 * a link checker is the instrument it would have arrived as.
 */
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

/*
 * Derived from the list above rather than written out, so a tool added to
 * MARKDOWN_TOOLS is covered at every gate without a second edit. Hand-writing
 * it left `lychee`, `dprint`, `mdformat` and bare `remark` uncovered, so
 * `npx lychee --offline .` in CI passed the gate cases (mantahostels#1540 review).
 */
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
		/*
		 * A config file is the other way one of these arrives: a tool run through
		 * `npx` needs no dependency entry, but still wants its rules written down.
		 * The alternation covers the dotfile, the `.config.js|mjs|cjs` and the
		 * bare-name spellings, plus lychee's ignore file.
		 */
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

		// The same rules can live inside package.json instead of beside it.
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
		// The two gates a Markdown step could be added to: the pre-commit hook,
		// and CI's existing `Lint and tests` job.
		expect(read(".husky", "pre-commit")).not.toMatch(TOOL_PATTERN);
		expect(read(".github", "workflows", "ci.yml")).not.toMatch(TOOL_PATTERN);
	});

	it("confirms Biome still cannot parse Markdown at all", () => {
		/*
		 * Biome has language keys for css/graphql/grit/html/javascript/json and
		 * no markdown key. The formatting decline was measured on Prettier, the
		 * only formatter on offer, whose table padding was the harm (#1822). When
		 * Biome ships Markdown support this case fails: re-measure the decline on
		 * Biome's output before keeping it.
		 *
		 * The positive half is what stops it passing vacuously: if Biome moves
		 * language config into `$defs` or behind `overrides`, `properties` stays
		 * populated and a bare absence assertion would hold forever while
		 * checking nothing (mantahostels#1540 review).
		 *
		 * Residual: reads `node_modules`, so in a throwaway worktree — which has
		 * none — this case cannot run and is skipped rather than reported.
		 */
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
		/*
		 * §W is the owner document for this map's declines (mantahostels#1537), alongside
		 * coverage (mantahostels#1136) and function length (mantahostels#1518). The assertion takes the
		 * bullet's own heading phrase, not the issue number, which appears twice
		 * in the file and so would survive the bullet's deletion (mantahostels#1540 review).
		 */
		expect(read("docs", "code-standards.md")).toMatch(
			/\*\*Markdown formatting, linting and link integrity — all three declined\*\*/,
		);
	});
});
