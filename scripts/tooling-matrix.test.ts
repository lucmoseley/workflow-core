// @vitest-environment node

/*
 * tooling-matrix.test.ts — docs/code-standards.md §W's load-bearing claims, and
 * the base's §0 floor of the shipped pre-commit's code gates, are still true
 * of the live config.
 *
 * DEPARTS FROM §X3, DELIBERATELY (§G4). That rule asks a `scripts/` test to run
 * its subject as a subprocess and assert the exit code and the message. The
 * subject here is the repo's own config files and the linters reading them, not
 * a script, so most cases read config text. What the file runs: ESLint,
 * eslint-plugin-react-hooks and TypeScript's config reader as libraries; `git
 * init` and Biome's node shim, which spawns its native binary, as subprocesses
 * in a temp probe project, Biome's exit code
 * carrying nothing its category list does not; and `scripts/lib/formatters.js
 * shell-files --tracked` in-process against this repo, which spawns `git
 * ls-files` and `git check-attr`, read for its output alone.
 *
 * THE PROBLEM. A prose matrix describing live config rots silently; these cases
 * make it rot loudly (mantahostels#1537).
 *
 * SCOPE: the claims that change a review sub-agent's behaviour, not all of §W.
 * A case here is worth its cost only where getting it wrong makes a reviewer
 * skip a convention tooling does NOT enforce, or write one it does.
 *
 * WHY THE TEMP PROJECT. A rule scoped by `biome.json` `overrides` can only be
 * tested from a real path inside a project, and mantahostels#1518 measured that
 * `biome lint --only=<rule>` cannot stand in: it forces the rule on globally
 * and ignores both configured severity and `overrides`. Writing a probe into
 * this repo's own `app/` would put a lint finding in a shared working tree
 * where a parallel session's whole-repo `npm run check` would trip over it, so
 * the probe copies the REAL biome.json and package.json into a temp project
 * instead — the two inputs that decide the answer, since Biome's `react` and
 * `next` domains auto-enable off the declared dependencies.
 *
 * It runs in CI's Vitest step: loosen a case and §W can claim a rule the live
 * config no longer sets, or miss one it does, so a review sub-agent skips a
 * convention nothing enforces or re-flags one tooling already refuses.
 *
 * Coverage is deliberately not re-pinned here: scripts/coverage-declined.test.ts
 * already owns mantahostels#1136's decline.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";
import { testGate } from "./lib/test-gate.js";

const ROOT = path.join(__dirname, "..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const BIOME = path.join(ROOT, "node_modules", ".bin", "biome");

interface Diagnostic {
	category?: string;
	severity?: string;
	message?: string;
	location?: { path?: string };
}

/**
 * Lint probe files under this repo's real Biome config, from a throwaway
 * project so `overrides` globs resolve against a path we control. `files` maps
 * a relative path to its content, and may overwrite the copied package.json.
 * Returns every diagnostic Biome reported on the paths `lint` names.
 */
function biomeDiagnostics(
	files: Record<string, string>,
	lint: string[] = Object.keys(files),
): Diagnostic[] {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wfc-biome-"));
	try {
		fs.copyFileSync(
			path.join(ROOT, "biome.json"),
			path.join(dir, "biome.json"),
		);
		fs.copyFileSync(
			path.join(ROOT, "package.json"),
			path.join(dir, "package.json"),
		);
		// biome.json sets vcs.useIgnoreFile, which errors out with no repository
		// and no ignore file to read.
		fs.writeFileSync(path.join(dir, ".gitignore"), "");
		execFileSync("git", ["init", "-q"], { cwd: dir });
		for (const [relPath, source] of Object.entries(files)) {
			const target = path.join(dir, relPath);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, source);
		}
		let stdout = "";
		try {
			stdout = execFileSync(
				BIOME,
				["lint", "--reporter=json", "--max-diagnostics=none", ...lint],
				{ cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
			);
		} catch (error) {
			// biome exits non-zero whenever it reports a diagnostic, which is the
			// case every probe here is written to produce.
			stdout = (error as { stdout?: string }).stdout ?? "";
		}
		return (
			(JSON.parse(stdout) as { diagnostics?: Diagnostic[] }).diagnostics ?? []
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The rule categories that fired on one probe file. */
function biomeCategories(relPath: string, source: string): string[] {
	return biomeDiagnostics({ [relPath]: source }).map((d) => d.category ?? "");
}

/** `rule` fires among `diagnostics`, and every firing is at error, not warn. */
function expectRefusedAtError(
	diagnostics: Diagnostic[],
	rule: string,
	label: string,
): void {
	const here = diagnostics.filter((d) => d.category === rule);
	expect(here, label).not.toEqual([]);
	for (const d of here) expect(d.severity, `${label} at error`).toBe("error");
}

/* 12 nested `if`s, comfortably past the threshold of 15 that biome.json pins
 * noExcessiveCognitiveComplexity to (mantahostels#1518): each nesting level costs more than
 * one point. */
const NESTED = (() => {
	let body = "export function deep(n: number): number {\n";
	for (let i = 0; i < 12; i++) body += `\tif (n > ${i}) {\n`;
	body += "\t\treturn n;\n";
	for (let i = 0; i < 12; i++) body += "\t}\n";
	return `${body}\treturn 0;\n}\n`;
})();

const HOOK_MISUSE = `import { useEffect, useState } from "react";
export function C({ a }: { a: number }) {
	if (a > 0) {
		const [s] = useState(0);
		return <b>{s}</b>;
	}
	useEffect(() => {
		console.log(a);
	}, []);
	return <i />;
}
`;

describe("§W — Biome's effective rule set is wider than biome.json", () => {
	it("fires the react-domain hook rules on app/ TSX that biome.json never names", () => {
		// The whole reason §W says "read the effective set, never the config
		// file". If this stops firing, ESLint's react-hooks preset is no longer
		// duplicated and eslint.config.mjs's comment goes stale with it.
		const config = read("biome.json");
		expect(config).not.toMatch(/useHookAtTopLevel/);
		expect(config).not.toMatch(/useExhaustiveDependencies/);

		const fired = biomeCategories("app/probe.tsx", HOOK_MISUSE);
		expect(fired).toContain("lint/correctness/useHookAtTopLevel");
		expect(fired).toContain("lint/correctness/useExhaustiveDependencies");
	});

	it("scopes noExcessiveCognitiveComplexity to app/, lib/, scripts/ and .claude/, and nowhere else", () => {
		// §W tells a reviewer never to raise complexity on these four paths
		// (#1318 Q2 (A)), which holds only while Biome really refuses it there.
		const rule = "lint/complexity/noExcessiveCognitiveComplexity";
		for (const where of [
			"app/deep.ts",
			"lib/deep.ts",
			"scripts/deep.ts",
			".claude/skills/any/deep.ts",
		]) {
			expectRefusedAtError(biomeDiagnostics({ [where]: NESTED }), rule, where);
		}
		expect(biomeCategories("deep.config.ts", NESTED)).not.toContain(rule);
	});

	it("caps parameters at Biome's default in programs and skill scripts as in app/ and lib/", () => {
		// §W tells a reviewer never to raise a long parameter list on these
		// paths (#1313), which holds only while Biome really refuses one there.
		const five =
			"export function f(a, b, c, d, e) {\n\treturn [a, b, c, d, e];\n}\n";
		for (const where of [
			"app/p.ts",
			"lib/p.ts",
			"scripts/p.js",
			"scripts/lib/p.js",
			".claude/skills/any/scripts/p.js",
		]) {
			expect(biomeCategories(where, five), where).toContain(
				"lint/complexity/useMaxParams",
			);
		}
		const four = "export function f(a, b, c, d) {\n\treturn [a, b, c, d];\n}\n";
		expect(biomeCategories("scripts/p.js", four)).not.toContain(
			"lint/complexity/useMaxParams",
		);
	});

	it("refuses a missing return type in library .ts only, never in a component, a test or a program", () => {
		// §W hands base §T1's library limb to useExplicitReturnType (#1335). The
		// rule is nursery under a caret pin, so a Biome bump that drops or
		// widens it fails here rather than silently moving §T1's line.
		const helper = "export function f(n: number) {\n\treturn n + 1;\n}\n";
		const component = `${helper}export function Nav() {\n\treturn <nav />;\n}\n`;
		const rule = "lint/nursery/useExplicitReturnType";
		for (const where of ["lib/p.ts", "lib/deep/p.ts", "app/api/route.ts"]) {
			expect(biomeCategories(where, helper), where).toContain(rule);
		}
		for (const where of [
			"lib/p.test.ts",
			"lib/test/fixture.ts",
			"scripts/p.ts",
		]) {
			expect(biomeCategories(where, helper), where).not.toContain(rule);
		}
		for (const where of ["lib/p.tsx", "app/page.tsx"]) {
			expect(biomeCategories(where, component), where).not.toContain(rule);
		}
	});

	it("keeps noFloatingPromises on across both surfaces, and noExplicitAny at error", () => {
		const source =
			"export async function go(): Promise<void> {}\n" +
			"export function caller(): void {\n\tgo();\n}\n" +
			"export function anyf(x: any): any {\n\treturn x;\n}\n";
		for (const where of ["app/p.ts", "scripts/p.ts"]) {
			const fired = biomeCategories(where, source);
			expect(fired, where).toContain("lint/nursery/noFloatingPromises");
			expect(fired, where).toContain("lint/suspicious/noExplicitAny");
		}
		const rules = JSON.parse(read("biome.json")).linter.rules;
		expect(rules.suspicious.noExplicitAny).toBe("error");
		expect(rules.style.noNonNullAssertion).toBe("error");

		// §W states this total in prose, so a miscount there ships unchallenged.
		// `preset` is the recommended set, not an entry.
		const explicit = Object.entries(rules)
			.filter(([group]) => group !== "preset")
			.reduce((n, [, group]) => n + Object.keys(group as object).length, 0);
		expect(explicit).toBe(223);
		expect(Object.keys(rules.nursery)).toHaveLength(28);

		// §W states the path-scoped total too — pin it like the one above.
		const config = JSON.parse(read("biome.json"));
		const scoped = config.overrides.find(
			(o: { includes: string[] }) =>
				o.includes.join() === ["app/**", "lib/**"].join(),
		);
		const scopedCount = Object.values(
			scoped.linter.rules as Record<string, object>,
		).reduce((n, group) => n + Object.keys(group).length, 0);
		expect(scopedCount).toBe(15);
	});

	it("refuses #1318's repo-wide rules in scripts/, not only in app/ and lib/", () => {
		// §W tells a reviewer these rules bind everywhere, which holds only
		// while each really fires outside the product override. Each row is
		// its own probe file, so a row passes on its own snippet alone. A Biome
		// bump that moves a nursery rule fails here too.
		const rows: [rule: string, source: string][] = [
			[
				"nursery/useReduceTypeParameter",
				"export const r = [1].reduce((a, n) => a.concat(n), [] as number[]);\n",
			],
			[
				"nursery/useDomNodeTextContent",
				"export const t = (el: HTMLElement) => el.innerText;\n",
			],
			[
				"nursery/useIncludes",
				'export const has = (a: string[]) => a.indexOf("x") !== -1;\n',
			],
			[
				"nursery/useStringStartsEndsWith",
				'export const starts = (s: string) => s.indexOf("x") === 0;\n',
			],
			[
				"nursery/useArraySome",
				"export const any = (a: number[]) => a.find((n) => n > 1) !== undefined;\n",
			],
			[
				"nursery/useRegexpTest",
				"export const hit = (s: string) => (s.match(/x/) ? 1 : 0);\n",
			],
			[
				"correctness/useUniqueElementIds",
				'export function Fixed() {\n\treturn <div id="fixed" />;\n}\n',
			],
			[
				"complexity/useFlatMap",
				"export const flat = (a: number[][]) => a.map((x) => x).flat();\n",
			],
			[
				"complexity/useIndexOf",
				"export const at = (a: number[]) => a.findIndex((n) => n === 1);\n",
			],
			["style/useExponentiationOperator", "export const p = Math.pow(2, 3);\n"],
			[
				"style/useShorthandFunctionType",
				"export interface Callable {\n\t(): void;\n}\n",
			],
			[
				"correctness/noUnusedInstantiation",
				"export function f() {\n\tnew Date();\n}\n",
			],
			[
				"complexity/useArrayFind",
				"export const first = (a: number[]) => a.filter((n) => n > 1)[0];\n",
			],
			[
				"style/noInferrableTypes",
				'export const f = (r: string = "{}") => r;\n',
			],
			[
				"style/noExcessiveClassesPerFile",
				"export class One {}\nexport class Two {}\n",
			],
			[
				"style/useForOf",
				"export function sum(a: number[]) {\n\tlet t = 0;\n\tfor (let i = 0; i < a.length; i++) t += a[i];\n\treturn t;\n}\n",
			],
			["style/useNumberNamespace", "export const big = Infinity;\n"],
			[
				"style/useConsistentArrayType",
				"export const xs: Array<string> = [];\n",
			],
			[
				"complexity/noUselessUndefined",
				"export function f() {\n\treturn undefined;\n}\n",
			],
			[
				"style/useAtIndex",
				"export const last = (a: number[]) => a[a.length - 1];\n",
			],
			["style/noUnusedTemplateLiteral", "export const s = `plain`;\n"],
			["style/useNumericSeparators", "export const big = 1000000;\n"],
			[
				"style/useExplicitLengthCheck",
				"export const e = (a: string[]) => !a.length;\n",
			],
			[
				"style/noNestedTernary",
				'export const n = (x: number) => (x > 1 ? "a" : x > 0 ? "b" : "c");\n',
			],
			[
				"style/useConsistentMethodSignatures",
				"export interface Run {\n\tgo(): void;\n}\n",
			],
			[
				"style/noNegationElse",
				"export const n = (x?: number) => (x !== undefined ? x : 0);\n",
			],
			[
				"complexity/noForEach",
				"export const log = (a: string[]) => a.forEach((s) => console.log(s));\n",
			],
			[
				"style/useConsistentTypeDefinitions",
				"export type Shape = { side: number };\n",
			],
			[
				"style/useErrorCause",
				'export function f() {\n\ttry {\n\t\tJSON.parse("");\n\t} catch (e) {\n\t\tthrow new Error(String(e));\n\t}\n}\n',
			],
			[
				"suspicious/noEmptyBlockStatements",
				'export function f() {\n\ttry {\n\t\tJSON.parse("");\n\t} catch {}\n}\n',
			],
			[
				"suspicious/noShadow",
				"export function f(x: number) {\n\treturn [1].map((x) => x + 1);\n}\n",
			],
			[
				"correctness/noUndeclaredDependencies",
				'export { default } from "left-pad";\n',
			],
		];
		const probe = (i: number) => `scripts/probe-${i}.tsx`;
		const fired = biomeDiagnostics(
			Object.fromEntries(rows.map(([, source], i) => [probe(i), source])),
		);
		for (const [i, [rule]] of rows.entries()) {
			expectRefusedAtError(
				fired.filter((d) => d.location?.path === probe(i)),
				`lint/${rule}`,
				rule,
			);
		}
	});

	it("leaves claude-code, which the engine supplies, undeclared under hooks/ and the mods", () => {
		const source = 'export type { Register } from "claude-code";\n';
		const paths = [
			"scripts/engine.ts",
			"hooks/engine.ts",
			".claude/skills/wfc-probe/hooks/engine.ts",
		];
		const fired = biomeDiagnostics(
			Object.fromEntries(paths.map((p) => [p, source])),
		).filter((d) => d.category === "lint/correctness/noUndeclaredDependencies");
		const at = (p: string) => fired.filter((d) => d.location?.path === p);
		expect(at("scripts/engine.ts")).toHaveLength(1);
		expect(at("hooks/engine.ts")).toEqual([]);
		expect(at(".claude/skills/wfc-probe/hooks/engine.ts")).toEqual([]);
	});

	it("refuses a GNU-family or non-OSI direct dependency, naming its licence, and passes MIT and MPL", () => {
		// #1353 Q1 (A): the deny list is the GPL family on top of
		// requireOsiApproved, and file-level copyleft stays allowed. The rule
		// reads each declared dependency's own package.json under node_modules.
		const licences: Record<string, string> = {
			"p-agpl": "AGPL-3.0-only",
			"p-lgpl": "LGPL-3.0-only",
			"p-cc0": "CC0-1.0",
			"p-mit": "MIT",
			"p-mpl": "MPL-2.0",
		};
		const files: Record<string, string> = {
			"package.json": JSON.stringify({
				name: "probe",
				private: true,
				dependencies: Object.fromEntries(
					Object.keys(licences).map((name) => [name, "1.0.0"]),
				),
			}),
		};
		for (const [name, license] of Object.entries(licences)) {
			files[`node_modules/${name}/package.json`] = JSON.stringify({
				name,
				version: "1.0.0",
				license,
			});
		}
		const messages = biomeDiagnostics(files, ["package.json"])
			.filter((d) => d.category === "lint/nursery/noUntrustedLicenses")
			.map((d) => d.message ?? "");
		const about = (name: string) => messages.filter((m) => m.includes(name));
		expect(about("p-agpl")).toEqual([
			expect.stringContaining("denied license: AGPL-3.0-only"),
		]);
		expect(about("p-lgpl")).toEqual([
			expect.stringContaining("denied license: LGPL-3.0-only"),
		]);
		expect(about("p-cc0")).toEqual([
			expect.stringContaining("not OSI-approved: CC0-1.0"),
		]);
		expect(about("p-mit")).toEqual([]);
		expect(about("p-mpl")).toEqual([]);
	});

	it("refuses base §G5's tool-checkable names at error in scripts/ and lib/, and passes the shapes §W leaves alone", () => {
		// §W tells a reviewer not to raise what useNamingConvention refuses, and
		// to keep raising its four review-only limbs (#1328 Q2 (A)). Both hold
		// only while these fire and these stay silent.
		const fires: [claim: string, file: string, source: string][] = [
			[
				"an all-capitals const inside a function",
				"p.ts",
				"export function f() {\n\tconst MAX_TRIES = 3;\n\treturn MAX_TRIES;\n}\n",
			],
			[
				"an all-capitals const inside a describe callback",
				"p.test.ts",
				'import { describe, expect, it } from "vitest";\ndescribe("d", () => {\n\tconst LIMIT = 3;\n\tit("t", () => {\n\t\texpect(LIMIT).toBe(3);\n\t});\n});\n',
			],
			[
				"an all-capitals let at module scope",
				"p.ts",
				'let ROOT = "a";\nROOT += "b";\nexport { ROOT };\n',
			],
			[
				"a snake_case parameter",
				"p.ts",
				"export function f(tool_input: string) {\n\treturn tool_input;\n}\n",
			],
			[
				"an all-capitals parameter",
				"p.ts",
				"export function f(PATH: string) {\n\treturn PATH;\n}\n",
			],
			[
				"a snake_case local",
				"p.ts",
				"export function f() {\n\tconst file_path = 1;\n\treturn file_path;\n}\n",
			],
			[
				"a snake_case method",
				"p.ts",
				"export class Probe {\n\tread_file() {\n\t\treturn 1;\n\t}\n}\n",
			],
			["a lower-case class", "p.ts", "export class probe {}\n"],
			["a lower-case interface", "p.ts", "export interface probe {}\n"],
			["a lower-case type alias", "p.ts", "export type probe = number;\n"],
		];
		const silent: [claim: string, source: string][] = [
			[
				"an all-capitals const at module scope",
				"export const MAX_TRIES = 3;\n",
			],
			// §W's limb 1: a camelCase module constant stays review's to raise.
			["a camelCase const at module scope", "export const maxTries = 3;\n"],
			[
				"external object keys",
				'export const o = { created_at: 1, CLAUDE_PROJECT_DIR: "x", _schema: 1, $note: "n" };\n',
			],
			[
				"snake_case object-literal and interface methods",
				"export const o = { read_file() {} };\nexport interface I {\n\tget_x(): number;\n}\n",
			],
			[
				"an external type member",
				"export type T = { pull_request: number };\n",
			],
			[
				"acronym casing",
				"export function readJSON(s: string) {\n\tconst toolUseID = s;\n\treturn JSON.parse(toolUseID);\n}\n",
			],
			[
				"shorthand destructuring of an external key",
				"export function f(payload: { tool_input: string }) {\n\tconst { tool_input } = payload;\n\treturn tool_input;\n}\n",
			],
		];
		const roots = ["scripts", "lib"];
		const fireCases = roots.flatMap((root) =>
			fires.map(([claim, file, source], i) => ({
				root,
				claim,
				probe: `${root}/fires-${i}-${file}`,
				source,
			})),
		);
		const silentCases = roots.flatMap((root) =>
			silent.map(([claim, source], i) => ({
				root,
				claim,
				probe: `${root}/silent-${i}.ts`,
				source,
			})),
		);
		const naming = biomeDiagnostics(
			Object.fromEntries(
				[...fireCases, ...silentCases].map((c) => [c.probe, c.source]),
			),
		).filter((d) => d.category === "lint/style/useNamingConvention");
		const at = (p: string) => naming.filter((d) => d.location?.path === p);
		for (const { root, claim, probe } of fireCases) {
			const here = at(probe);
			expect(here, `${root}: ${claim} is refused`).not.toEqual([]);
			for (const d of here)
				expect(d.severity, `${root}: ${claim} is refused at error`).toBe(
					"error",
				);
		}
		for (const { root, claim, probe } of silentCases) {
			expect(at(probe), `${root}: ${claim} passes`).toEqual([]);
		}
	});
});

describe("§W — which checker sees which surface", () => {
	it("matches ESLint to app/ and lib/ TypeScript and to nothing under scripts/", async () => {
		const { ESLint } = require("eslint") as typeof import("eslint");
		const eslint = new ESLint({ cwd: ROOT });
		for (const file of [
			"app/page.tsx",
			"app/layout.tsx",
			"lib/review-strip/audit-sample.ts",
		]) {
			const config = (await eslint.calculateConfigForFile(file)) as {
				rules?: Record<string, unknown>;
			};
			expect(Object.keys(config.rules ?? {}), file).toHaveLength(38);
		}
		// Not null: flat config still returns a config object for an unmatched
		// path. What makes it unmatched is that no rule survives into it.
		const scriptConfig = (await eslint.calculateConfigForFile(
			"scripts/pick-next.js",
		)) as { rules?: Record<string, unknown> };
		expect(Object.keys(scriptConfig.rules ?? {})).toHaveLength(0);
	});

	it("keeps the 15 React Compiler rules that are ESLint's whole remaining reason to exist", () => {
		// Dropping the preset would delete these 15 rather than consolidate 2.
		const preset = require("eslint-plugin-react-hooks").configs.flat[
			"recommended-latest"
		];
		const names = Object.keys(preset.rules);
		// 17 = the 15 compiler rules plus rules-of-hooks and exhaustive-deps,
		// which Biome's react domain now owns.
		expect(names).toHaveLength(17);
		for (const rule of [
			"react-hooks/set-state-in-effect",
			"react-hooks/purity",
			"react-hooks/immutability",
			"react-hooks/refs",
			"react-hooks/preserve-manual-memoization",
		]) {
			expect(names).toContain(rule);
		}
	});

	it("carries scripts/ and the skill scripts in the tsc program", () => {
		// `checkJs` is on across `scripts/**/*.js`, so a file is checked whether
		// or not it carries `// @ts-check`, as §N8 requires.
		const tsconfig = read("tsconfig.json");
		expect(tsconfig).toMatch(/"scripts\/\*\*\/\*\.js"/);
		expect(tsconfig).toMatch(/"\.claude\/skills\/\*\/scripts\/\*\.ts"/);
		expect(tsconfig).toMatch(/"checkJs"\s*:\s*true/);
	});

	it("excludes only .claude/'s worktrees and settings from Biome, not .claude/", () => {
		// mantahostels#1138. Biome cannot re-include inside an excluded path, so `!.claude`
		// returning would silently take the skill scripts back out.
		const includes = JSON.parse(read("biome.json")).files.includes as string[];
		expect(includes).toContain("!.claude/worktrees");
		expect(includes).not.toContain("!.claude");
		// The whole exclusion list, not a sample: §W's surface table names these
		// as seen by nothing, and one arriving silently would make that row
		// wrong.
		expect(includes.filter((entry) => entry.startsWith("!"))).toEqual([
			"!public",
			"!docs",
			"!.claude/worktrees",
			// The sanctioned scratch directory (mantahostels#2089, mantahostels#2103): scratch is not
			// linted, and the post-write core stops reformatting it on every write.
			"!.claude/tmp",
			"!.claude/settings*.json",
			// A mod's verbatim copy of the engine's API declarations (#854).
			"!.claude/skills/*/.claude-plugin/types",
			// Unsanctioned scratch, and where sessions put throwaway worktrees
			// (mantahostels#2206): a worktree's own biome.json reads as a nested root
			// configuration Biome refuses on repo-wide, blocking every commit.
			"!.local",
			"!skills-lock.json",
			// The plugin hook manifest, rendered by generate-plugin-hooks.js (#946).
			"!hooks/hooks.json",
			"!scripts/fixtures",
			// An adopter skeleton's templates (#5): a `{{placeholder}}` does not
			// parse as the language the template is a template for.
			"!scripts/templates",
		]);
	});

	it("keeps ruff at the select §W quotes", () => {
		const select = (text: string) =>
			JSON.parse(text.match(/select\s*=\s*(\[[^\]]*\])/)?.[1] ?? "null");
		const ruff = select(read("ruff.toml"));
		expect(ruff).toContain("BLE001");
		expect(ruff).toContain("N");
		expect(ruff).toEqual(select(read("docs/code-standards.md")));
	});

	it("caps Python's positional parameters at 4 with preview off (#1314, #1577)", () => {
		const toml = read("ruff.toml");
		const table = (name: string) =>
			toml.split(`\n[${name}]\n`)[1]?.split("\n[")[0] ?? "";
		expect(table("lint.pylint")).toMatch(/^max-positional-args\s*=\s*4$/m);
		// A top-level `preview` switches lint preview on too.
		expect(toml.split("\n[")[0]).not.toMatch(/^(lint\.)?preview\s*=/m);
		expect(table("lint")).not.toMatch(/^preview\s*=/m);
	});

	it("hands shellcheck every tracked shell file: all seven husky hooks, and no vendored skill (#1828)", () => {
		const checkSh = JSON.parse(read("package.json")).scripts["check:sh"];
		expect(checkSh).toContain(
			"$(node scripts/lib/formatters.js shell-files --tracked)",
		);
		const set = runInProcess(
			path.join(ROOT, "scripts/lib/formatters.js"),
			["shell-files", "--tracked"],
			{ cwd: ROOT },
		).stdout.split("\n");
		for (const hook of [
			"pre-commit",
			"prepare-commit-msg",
			"pre-merge-commit",
			"pre-applypatch",
			"post-commit",
			"pre-push",
			"commit-msg",
		]) {
			expect(set, hook).toContain(`.husky/${hook}`);
		}
		// Paired negative: a lister that swept every .sh would satisfy the seven
		// above. .agents/skills/ is vendored by .gitattributes — skill templates
		// carrying placeholders — so its absence is the discriminator.
		expect(set.filter((p) => p.startsWith(".agents/"))).toEqual([]);
	});
});

describe("§W — a warning is a refusal here", () => {
	it("fails every Biome and ESLint entry point on a warning", () => {
		const scripts = JSON.parse(read("package.json")).scripts;
		for (const name of ["lint", "check", "check:staged"]) {
			expect(scripts[name], name).toContain("--error-on-warnings");
		}
		expect(scripts["check:eslint"]).toContain("--max-warnings 0");
	});
});

describe("§W — which gate runs it in CI", () => {
	it("runs Biome over the staged paths at commit, and no suite there", () => {
		const core = JSON.parse(read(".claude/workflow-core.json"));
		const scripts = JSON.parse(read("package.json")).scripts;
		const npmScript = (command: string) =>
			scripts[/^npm run (\S+)$/.exec(command)?.[1] ?? ""] ?? "";
		expect(
			npmScript(core.commands.check_staged),
			"§W: commands.check_staged is Biome over the staged paths",
		).toMatch(/^node scripts\/biome-staged\.js /);
		expect(
			core.modules,
			"§W: commands.test writes a test-pass marker — module suites is on",
		).toContain("suites");
		expect(
			testGate({ root: ROOT }).gate,
			"§W: commands.test writes a test-pass marker — gated at push",
		).toBe("push");
	});

	it("runs Biome, ESLint, shellcheck, shfmt, actionlint, tsc and the suite in CI", () => {
		// One job, deliberately: Actions bills each job's minutes rounded up
		// (mantahostels#313), so §W's gate table has a single CI column rather
		// than one per checker.
		const ci = read(".github/workflows/ci.yml");
		for (const step of [
			"name: Biome ci",
			"name: ESLint",
			"name: Shellcheck",
			"name: shfmt",
			"name: actionlint",
			"name: Typecheck",
			"name: Vitest",
		]) {
			expect(ci, step).toContain(step);
		}
		// Paired negative: ci.yml carries no push trigger of its own —
		// scheduled-checks.yml's `landing` push calls it (#2413) — so a CI file
		// that simply listed every conceivable trigger would fail here rather than
		// pass the presence checks above.
		expect(ci).not.toMatch(/^on:\s*\n\s*push:/m);
	});

	it("puts gitleaks on the runner's PATH before Vitest, whatever failed first", () => {
		// #55: the gitleaks-gated cases skip green where the binary is absent.
		const ci = read(".github/workflows/ci.yml");
		const install = ci.indexOf("name: Install gitleaks");
		expect(install).toBeGreaterThan(-1);
		expect(install).toBeLessThan(ci.indexOf("- name: Vitest\n"));
		expect(ci.slice(install).split("\n")[1]).toContain("!cancelled()");
		expect(ci).toMatch(/GITLEAKS_SHA256: [0-9a-f]{64}/);
	});
});

describe("base §0's floor — the shipped pre-commit's code gates in every repo", () => {
	// Every adopter's §W leaves these to the base (#1826).
	const floor = (() => {
		const base = read("docs/code-standards-base.md");
		const start = base.indexOf("| Gate | Refuses | Where it runs |");
		return base.slice(start, base.indexOf("\n\n", start));
	})();
	const hook = read(".husky/pre-commit");

	it.each([
		["gitleaks", /gitleaks\}" git --staged --redact \|\| exit 1/],
		["`commands.check_staged`", /command check_staged/],
		["ESLint, `--max-warnings 0`", /eslint --max-warnings 0/],
		["`commands.typecheck`", /this commit is NOT blocked/],
		[
			"`scripts/check-code-standards.js`",
			/check-code-standards\.js --touching HEAD --warn/,
		],
		[
			"shellcheck, `-x --severity=style --exclude=SC2016`",
			/shellcheck -x --severity=style --exclude=SC2016/,
		],
		["actionlint", /actionlint \$tool_paths/],
		["ruff", /check-ruff-introduced\.js/],
		["`scripts/check-swallowed-errors.js`", /check-swallowed-errors\.js \|\|/],
		["`scripts/check-cli-args.js`", /check-cli-args\.js --against HEAD/],
		["`scripts/check-precommit-exit.js`", /check-precommit-exit\.js \|\|/],
		["`scripts/check-test-spawn.js`", /check-test-spawn\.js --index \|\| exit/],
		[
			"`scripts/check-jsonl-reads.js`",
			/check-jsonl-reads\.js --index \|\| exit/,
		],
		[
			"`scripts/check-clock-copies.js`",
			/check-clock-copies\.js --index \|\| exit/,
		],
		[
			"`scripts/check-report-programs.js`",
			/check-report-programs\.js --index \|\| exit/,
		],
		["`scripts/check-gh-route.js`", /check-gh-route\.js --index \|\| exit/],
		["`scripts/check-registrations.js`", /check-registrations\.js --against/],
		[
			"`scripts/check-workflow-permissions.js`",
			/check-workflow-permissions\.js \|\|/,
		],
		["`commands.test`", /test-gate\.js commit/],
		["`scripts/mutation-hold-gate.js`", /mutation-hold-gate\.js \|\|/],
	])("names %s, which the hook still runs", (gate, call) => {
		expect(floor).toContain(`| ${gate} |`);
		expect(hook).toMatch(call);
	});

	it("names the three test-isolation checkers in one row, all three still run", () => {
		for (const checker of [
			"check-guard-test-isolation",
			"check-host-root-test-isolation",
			"check-git-fixture-identity",
		]) {
			expect(floor).toContain(`scripts/${checker}.js`);
			expect(hook).toMatch(new RegExp(`${checker}\\.js --against HEAD`));
		}
	});

	it("gives shfmt the flags the format gate passes it", () => {
		// The hook hands formatting to check-format-staged.js, which takes its
		// shfmt options from lib/formatters.js.
		expect(floor).toContain("shfmt at `-i 2 -ci`");
		expect(hook).toMatch(
			/node "\$\{WFC_PLUGIN_ROOT:-\.\}"\/scripts\/check-format-staged\.js/,
		);
		expect(read("scripts/lib/formatters.js")).toContain(
			"const SHFMT_OPTIONS = { indent: 2, switchCaseIndent: true };",
		);
	});

	it("names every script the hook runs, or holds it here as no code gate", () => {
		// Spelled without `scripts/` or an extension, so the read-edge extractor
		// takes none for a read: the test reads the hook, not these.
		const notCode = new Set([
			// A row names the tool these run for.
			"check-ruff-introduced",
			"check-format-staged",
			"biome-staged",
			"lib/infer-commands",
			"lib/test-gate",
			// Helpers the gates call.
			"lib/precommit-gate",
			"lib/hook-root",
			"lib/serialised",
			"lib/workflow-core-config",
			"lib/formatters",
			"lib/commit-key",
			"lib/check",
			"lib/doc-map",
			"lib/always-loaded-pool",
			"lib/isolated-worktree",
			"checker-new-faults",
			// Named in a refusal's message, never run.
			"commit-paths",
			"guard-hook-escape",
			"inject-tracker-docs",
			// Named in the hook's comments, never run.
			"guard-dispatch",
			"lib/commit-form",
			"lib/clean-revert",
			// Judges the settings snapshot, not code.
			"check-user-settings-drift",
			// Documents, the roadmap, the copy and the repo's own registers.
			"stale-write-back-gate",
			"review-hold-gate",
			"check-roadmap-pair",
			"check-roadmap-valid",
			"check-citation-tracker",
			"check-gate-switches",
			"check-lockfile-sync",
			"check-research-added",
			"check-digest-version",
			"check-digest-render",
			"gen-roadmap-digest",
			"check-vendored-skills",
			"check-guard-registry",
			"check-hook-liveness",
			"generate-plugin-hooks",
			"generate-rule-fragments",
			"check-website-copy",
			"check-doc-map",
			"check-context-budget",
			"check-injector-margin",
			"check-superseded-values",
		]);
		const run = new Set(hook.match(/scripts\/[\w/-]+\.(?:js|sh)/g));
		expect(run.size).toBeGreaterThan(0);
		const unplaced = [...run].filter(
			(script) =>
				!(
					notCode.has(
						script.slice("scripts/".length).replace(/\.(?:js|sh)$/, ""),
					) || floor.includes(script)
				),
		);
		expect(unplaced).toEqual([]);
	});
});

describe("§W — which tsc flags are still off", () => {
	it("leaves exactOptionalPropertyTypes and noPropertyAccessFromIndexSignature as the only two", () => {
		// §W tells a reviewer these are the only flags left to write a prose rule
		// about.
		const tsconfig = read("tsconfig.json");
		for (const flag of [
			"noImplicitReturns",
			"noFallthroughCasesInSwitch",
			"noImplicitOverride",
			"verbatimModuleSyntax",
			"noUnusedLocals",
			"noUnusedParameters",
		]) {
			expect(tsconfig, flag).toMatch(new RegExp(`"${flag}"\\s*:\\s*true`));
		}
		expect(tsconfig).not.toMatch(/"exactOptionalPropertyTypes"/);
		expect(tsconfig).not.toMatch(/"noPropertyAccessFromIndexSignature"/);
	});

	it("scopes noUncheckedIndexedAccess to app/, lib/ and the programs, minus their tests, through tsconfig.strict.json", () => {
		// mantahostels#1064, #1336. `npm run typecheck` runs both configs, so the flag is
		// gated; the scoping is why §W's surface table qualifies its tsc column.
		/** A tsconfig parsed as tsc reads it, comments and all. */
		const readConfig = (file: string) =>
			ts.readConfigFile(path.join(ROOT, file), ts.sys.readFile).config as {
				compilerOptions?: Record<string, unknown>;
				include: string[];
				exclude: string[];
			};
		const strict = readConfig("tsconfig.strict.json");
		expect(strict.compilerOptions?.noUncheckedIndexedAccess).toBe(true);
		expect(strict.include).toEqual(
			expect.arrayContaining([
				"app/**/*.tsx",
				"lib/**/*.ts",
				"scripts/**/*.js",
				"scripts/**/*.ts",
				".claude/skills/*/scripts/*.js",
				".claude/skills/*/scripts/*.ts",
			]),
		);
		// A child's `exclude` replaces its parent's, so the base list must be repeated.
		expect(strict.exclude).toEqual(
			expect.arrayContaining([
				...readConfig("tsconfig.json").exclude,
				"scripts/**/*.test.*",
				"scripts/**/test/**",
				".claude/skills/*/scripts/*.test.*",
			]),
		);
		// Excluding app/ or lib/ tests would drop coverage they had before #1336.
		expect(strict.exclude.filter((g) => /^(app|lib)\//.test(g))).toEqual([]);
		expect(JSON.parse(read("package.json")).scripts.typecheck).toContain(
			"tsconfig.strict.json",
		);
	});
});
