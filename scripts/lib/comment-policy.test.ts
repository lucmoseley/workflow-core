// @vitest-environment node

import { describe, expect, it } from "vitest";
import { depsPattern, judgeSource, langOf } from "./comment-policy.js";
import { GATES } from "./precommit-gates.js";
import { qualifyCitations } from "./qualify-citations.js";

type Lang = "js" | "py" | "sh";

const facts = (lang: Lang, over: Record<string, unknown> = {}) => ({
	lang,
	checkJs: true,
	exports: new Set<string>(),
	shipped: false,
	fileName: "",
	adrs: new Set(["0010"]),
	deps: depsPattern(["vitest", "@biomejs/biome"]),
	styleOnly: {
		biome: ["format", "lint/style"],
		ruff: ["E5", "PLR09"],
	} as Record<string, string[]>,
	commentMarkers: [] as string[],
	...over,
});

const judge = (source: string, lang: Lang, over = {}) =>
	judgeSource(source, facts(lang, over));
const tags = (source: string, lang: Lang, over = {}) =>
	judge(source, lang, over).map((b) => `${b.tag}@${b.line}`);

describe("the permitted shapes", () => {
	it("passes a licence or SPDX line at the file top, past a shebang (K1)", () => {
		expect(
			tags(
				"#!/usr/bin/env node\n// SPDX-License-Identifier: MIT\nconst a = 1;\n",
				"js",
			),
		).toEqual([]);
		expect(tags("# Copyright 2026 A\nx = 1\n", "py")).toEqual([]);
	});

	it("refuses a licence line below code", () => {
		expect(tags("const a = 1;\n// Copyright 2026 A\n", "js")).toEqual([
			"COMMENT@2",
		]);
	});

	it("passes a suppression naming a rule on the style-only list (K3)", () => {
		const src = [
			"// biome-ignore lint/style/noNonNullAssertion: narrowed above",
			"const a = b!;",
			"// biome-ignore format: a table",
			"const t = [1,2];",
			"",
		].join("\n");
		expect(tags(src, "js")).toEqual([]);
		expect(tags("import os  # noqa: E501\n", "py")).toEqual([]);
		expect(tags("def f(a, b, c, d, e, f):  # noqa: PLR0913\n", "py")).toEqual(
			[],
		);
	});

	it("passes an ADR-NNNN pointer that resolves under docs/adr/", () => {
		expect(tags("// ADR-0010\nconst a = 1;\n", "js")).toEqual([]);
	});

	it("passes a one-line derivation holding measured or guess and a #N", () => {
		expect(
			tags("const CAP = 5; // measured: 4.1 s at p95 (#812)\n", "js"),
		).toEqual([]);
		expect(tags("# A guess, see #77\nLIMIT = 3\n", "py")).toEqual([]);
		expect(
			tags("# measured 3 s\n# over two lines (#77)\nLIMIT = 3\n", "py"),
		).toEqual(["COMMENT@1"]);
	});

	it("passes a bare #N, owner/repo#N or RFC pointer, several together (K5)", () => {
		const src = [
			"// #5455",
			"const a = 1;",
			"// (lucmoseley/mantahostels#3763, #12)",
			"const b = 1;",
			"// RFC 9110 §15.5",
			"const c = 1;",
			"// https://www.rfc-editor.org/rfc/rfc9110#section-15",
			"const d = 1;",
			"",
		].join("\n");
		expect(tags(src, "js")).toEqual([]);
	});

	it("passes the release's qualified pointer, and no other bare repo#N (#5694)", () => {
		const src = [
			"/**",
			" * #1274, #5504",
			" * @param {string} at",
			" */",
			"function readJson(at) {}",
			"/* #4117 */",
			"const a = 1;",
			"// measured 3 s, #77",
			"const b = 1;",
			"",
		].join("\n");
		expect(tags(src, "js")).toEqual([]);
		expect(tags(qualifyCitations(src, "scripts/lib/x.js"), "js")).toEqual([]);
		expect(tags("/* repo#12 */\nconst a = 1;\n", "js")).toEqual(["COMMENT@1"]);
	});

	it("refuses a pointer with reasoning prose beside it", () => {
		expect(tags("// kept for the lander, #5455\nconst a = 1;\n", "js")).toEqual(
			["COMMENT@1"],
		);
	});

	it("passes a comment naming its source, a URL or a manifest dependency (K2)", () => {
		expect(
			tags(
				"// Biome reads this shape: https://biomejs.dev/x\nconst a = 1;\n",
				"js",
			),
		).toEqual([]);
		expect(tags("/* `vitest` runs it twice */\nconst a = 1;\n", "js")).toEqual(
			[],
		);
		expect(
			tags("// `@biomejs/biome` sorts these\nconst a = 1;\n", "js"),
		).toEqual([]);
	});

	it("passes a source note whose fact takes one line and its URL the next (#5589)", () => {
		expect(
			tags(
				"// from https://example.com/x\nconst a = 1;\n// `grep -c` exits 1 on no match:\n// https://www.gnu.org/software/grep/manual/grep.html\nconst b = 1;\n",
				"js",
			),
		).toEqual([]);
	});

	it("refuses a multi-line essay that one URL or dependency would clear (#5589)", () => {
		const essay = [
			"/*",
			" * WHY THIS EXISTS: the ledger drifted twice before this checker.",
			" * We measured 40 misses a week, then 3 once it ran.",
			" * See [#1297](https://github.com/o/r/issues/1297).",
			" */",
			"const a = 1;",
			"",
		].join("\n");
		expect(tags(essay, "js")).toEqual(["COMMENT@1"]);
		expect(
			tags(
				"# `vitest` reruns it.\n# We chose two workers.\n# Then three.\nx = 1\n",
				"py",
			),
		).toEqual(["COMMENT@1"]);
		expect(
			tags(
				"// `vitest` ran it twice in May,\n// `vitest` then once in June,\n// and https://example.com/x says why.\nconst a = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1"]);
	});

	it("refuses a #N pointer's link as a source, and passes an upstream issue as one (#5589)", () => {
		expect(
			tags(
				"// WHY THIS EXISTS: history.\n// See [#1297](https://github.com/o/r/issues/1297).\nconst a = 1;\n// kept, per [o/r#12](https://github.com/o/r/pull/12)\nconst b = 1;\n// tsc widens this: https://github.com/microsoft/TypeScript/issues/9998\nconst c = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1", "COMMENT@4"]);
		expect(
			tags(
				"// WHY THIS EXISTS: history.\n// See [workflow-core#1297](https://github.com/o/r/issues/1297).\nconst a = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1"]);
	});

	it("refuses a dependency's name used as a word, unquoted or bare of its scope (#5492)", () => {
		const deps = {
			deps: depsPattern(["next", "@biomejs/biome", "@types/node"]),
		};
		expect(
			tags("// the next run reads it\nconst a = 1;\n", "js", deps),
		).toEqual(["COMMENT@1"]);
		expect(tags("// `biome` sorts these\nconst a = 1;\n", "js", deps)).toEqual([
			"COMMENT@1",
		]);
		expect(
			tags("// `@types/node` lacks this\nconst a = 1;\n", "js", deps),
		).toEqual(["COMMENT@1"]);
		expect(tags("// `next` caches this\nconst a = 1;\n", "js", deps)).toEqual(
			[],
		);
	});

	it("passes a doc on an export the helper surface lists (K4)", () => {
		const src = [
			"const x = 1;",
			"/** Runs it. */",
			"function runIt() {}",
			"/** Not shipped. */",
			"function other() {}",
			"module.exports = { runIt, other };",
			"",
		].join("\n");
		expect(tags(src, "js", { exports: new Set(["runIt"]) })).toEqual([
			"COMMENT@4",
		]);
		expect(
			tags('def run_it():\n    """Doc of run_it."""\n', "py", {
				exports: new Set(["run_it"]),
			}),
		).toEqual([]);
		expect(
			tags("# Logs a line.\ngl_log() {\n  :\n}\n", "sh", {
				exports: new Set(["gl_log"]),
			}),
		).toEqual([]);
	});

	describe("a shipped file's header (K4)", () => {
		const shipped = { shipped: true, fileName: "run-it.js" };

		it("passes a usage block on any line that invokes the file, citing no issue", () => {
			const cases: [Lang, string, string][] = [
				[
					"js",
					"run-it.js",
					"/*\n * Usage:\n *   node scripts/run-it.js <file>\n */\nconst a = 1;\n",
				],
				[
					"js",
					"run-it.js",
					"/*\n * const { runIt } = require('./run-it.js');\n * Exits 1 on a breach.\n */\nconst a = 1;\n",
				],
				[
					"js",
					"run-it.ts",
					'/* import { runIt } from "./run-it"; */\nconst a = 1;\n',
				],
				[
					"py",
					"run_it.py",
					'"""Usage, from a conftest:\n\n    run_it()\n"""\nx = 1\n',
				],
				[
					"py",
					"run_it.py",
					'"""import run_it, then call its exports."""\nx = 1\n',
				],
				["py", "run_it.py", '"""python3 scripts/run_it.py <file>"""\nx = 1\n'],
				[
					"sh",
					"run-it.sh",
					"#!/usr/bin/env bash\n# source lib/run-it.sh\nx=1\n",
				],
				[
					"sh",
					"run-it.sh",
					"#!/usr/bin/env bash\n# . lib/run-it.sh, then call it.\nx=1\n",
				],
				[
					"sh",
					"run-it.sh",
					"#!/usr/bin/env bash\n# bash scripts/run-it.sh <id>\nx=1\n",
				],
				[
					"js",
					"run-it.js",
					"/* node lib/resolve-core.js lib/run-it.js <file> */\nconst a = 1;\n",
				],
			];
			for (const [lang, fileName, src] of cases)
				expect(tags(src, lang, { shipped: true, fileName }), src).toEqual([]);
		});

		it("refuses a header that invokes nothing, or another file", () => {
			for (const src of [
				"/* What adopters import. */\nconst a = 1;\n",
				"/* Usage: */\nconst a = 1;\n",
				"/* node scripts/run-it.json */\nconst a = 1;\n",
				"/* runItNow() */\nconst a = 1;\n",
				"/* node is old; see run-it.js */\nconst a = 1;\n",
			])
				expect(tags(src, "js", shipped), src).toEqual(["COMMENT@1"]);
		});

		it("refuses a usage block citing an issue, in this repo or another", () => {
			for (const pointer of ["#12", "owner/repo#12", "repo#12"])
				expect(
					tags(
						`/*\n * Usage: node run-it.js (${pointer})\n */\nconst a = 1;\n`,
						"js",
						shipped,
					),
				).toEqual(["COMMENT@1"]);
		});

		it("judges a header in a file that is not shipped like any comment", () => {
			expect(
				tags("/* Usage: node run-it.js */\nconst a = 1;\n", "js", {
					fileName: "run-it.js",
				}),
			).toEqual(["COMMENT@1"]);
		});
	});

	it("refuses a doc parted from its export by a blank line", () => {
		expect(
			tags("/** Runs it. */\n\nfunction runIt() {}\n", "js", {
				exports: new Set(["runIt"]),
			}),
		).toEqual(["COMMENT@1"]);
	});
});

describe("JSDoc types checkJs reads are code", () => {
	it("passes a block of type tags alone, several to a line included", () => {
		const src = [
			"/** @type {number} */",
			"const a = 1;",
			"/** @param {string} a @param {number} [b=2] @returns {string} */",
			"const f = (a, b) => a;",
			"/**",
			" * @typedef {{ x: number }} Point",
			" * @template T, U",
			" * @template {string} [C=string]",
			" * @template T, [U = string]",
			' * @import { Ctx } from "./check"',
			" */",
			"",
		].join("\n");
		expect(tags(src, "js")).toEqual([]);
	});

	it("refuses the prose beside the types", () => {
		const out = judge(
			"/**\n * Adds them.\n * @param {number} a the first\n */\nconst f = (a) => a;\n",
			"js",
		);
		expect(out.map((b) => b.match)).toEqual(["Adds them. the first"]);
	});

	it("reads the tags as prose where checkJs is off", () => {
		expect(
			tags("/** @type {number} */\nconst a = 1;\n", "js", { checkJs: false }),
		).toEqual(["COMMENT@1"]);
	});
});

describe("the refused shapes", () => {
	it("refuses a prose comment, a run of line comments as one", () => {
		expect(
			tags("const a = 1;\n// one\n// two\nconst b = 2; // three\n", "js"),
		).toEqual(["COMMENT@2", "COMMENT@4"]);
	});

	it("refuses a suppression of a rule off the list, or naming none", () => {
		const out = judge(
			[
				"// biome-ignore lint/suspicious/noExplicitAny: a fake",
				"const a = 1;",
				"// eslint-disable-next-line",
				"const b = 1;",
				"// @ts-expect-error -- a fake",
				"const c = 1;",
				"",
			].join("\n"),
			"js",
		);
		expect(out.map((b) => `${b.tag}@${b.line}`)).toEqual([
			"SUPPRESSION@1",
			"SUPPRESSION@3",
			"SUPPRESSION@5",
		]);
		expect(out[0]?.why).toContain(
			"not on the style-only list (scripts/lib/style-only-rules.json)",
		);
		expect(out[1]?.why).toContain("suppression naming no rule");
		expect(tags("import os  # noqa\nx = 1  # type: ignore\n", "py")).toEqual([
			"SUPPRESSION@1",
			"SUPPRESSION@2",
		]);
		expect(tags("# shellcheck disable=SC2086\necho $x\n", "sh")).toEqual([
			"SUPPRESSION@1",
		]);
	});

	it("passes a Stryker disable stating its reason, and refuses one stating none (#5720)", () => {
		const src = (tail: string) =>
			[
				`// Stryker disable next-line EqualityOperator${tail}`,
				"const a = b <= c;",
				`/* Stryker disable all${tail} */`,
				"const d = 1;",
				"",
			].join("\n");
		expect(tags(src(": an equivalent mutant"), "js")).toEqual([]);
		const out = judge(src(""), "js");
		expect(out.map((b) => `${b.tag}@${b.line}`)).toEqual([
			"SUPPRESSION@1",
			"SUPPRESSION@3",
		]);
		expect(out[0]?.why).toContain(
			"a Stryker disable Stryker does not read, or one with no reason after its colon",
		);
		expect(tags(src(":"), "js")).toEqual(["SUPPRESSION@1", "SUPPRESSION@3"]);
		expect(
			tags(
				"// Stryker disable EqualityOperator: equivalent\nconst a = 1;\n// Stryker restore EqualityOperator\n",
				"js",
			),
		).toEqual([]);
	});

	it("refuses a reasoned Stryker disable that Stryker does not read as one (#5720)", () => {
		for (const head of [
			"stryker disable all",
			"Stryker  disable all",
			"Stryker disable next-line",
			"Stryker disable next-line X1",
		])
			expect(tags(`// ${head}: a reason\nconst a = 1;\n`, "js")).toEqual([
				"SUPPRESSION@1",
			]);
	});

	it("judges a Stryker disable on the raw comment value Stryker reads (#5748)", () => {
		const code = "\nconst a = 1;\n";
		expect(tags(`//  Stryker disable all: r${code}`, "js")).toEqual([
			"SUPPRESSION@1",
		]);
		expect(tags(`/**\n * Stryker disable all: r\n */${code}`, "js")).toEqual([
			"SUPPRESSION@2",
		]);
		expect(tags(`/*\n Stryker disable all: r\n */${code}`, "js")).toEqual([
			"SUPPRESSION@2",
		]);
		expect(tags(`// Stryker disable all: r${code}`, "js")).toEqual([]);
		expect(tags(`/* Stryker disable all: r */${code}`, "js")).toEqual([]);
		expect(tags(`//Stryker disable all: r${code}`, "js")).toEqual([]);
		expect(tags(`/*\nStryker disable all: r\n*/${code}`, "js")).toEqual([]);
		expect(tags("# Stryker disable all: r\nx = 1\n", "py")).toEqual([
			"SUPPRESSION@1",
		]);
	});

	it("admits a Stryker restore only where Stryker reads one (#5495)", () => {
		const code = "\nconst a = 1;\n";
		expect(tags(`// Stryker restore all${code}`, "js")).toEqual([]);
		expect(tags(`/*\nStryker restore all\n*/${code}`, "js")).toEqual([]);
		for (const head of ["//  Stryker restore all", "// stryker restore all"])
			expect(tags(`${head}: the mutant is equivalent${code}`, "js")).toEqual([
				"COMMENT@1",
			]);
	});

	it("judges the prose beside a suppression on its own", () => {
		expect(
			tags(
				"// why the rule is wrong here\n// biome-ignore lint/style/noX: ok\nconst a = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1"]);
	});

	it("prints each refusal with a line its gate row attributes it by (#5495)", () => {
		const row = GATES.find((g) => g.id === "comment-policy");
		const refusals = (row && "refusals" in row ? row.refusals : []).map((l) =>
			typeof l === "string" ? l : l.text,
		);
		const out = judge(
			[
				"// a stray remark",
				"const a = 1;",
				"// biome-ignore lint/suspicious/noX: ok",
				"const b = 1;",
				"// @ts-expect-error -- a fake",
				"const c = 1;",
				"// Stryker disable next-line EqualityOperator",
				"const d = a <= b;",
				"// ADR-0999",
				"const e = 1;",
				"",
			].join("\n"),
			"js",
		);
		expect(out).toHaveLength(5);
		for (const b of out)
			expect(
				refusals.some((l) => b.why.includes(l)),
				b.why,
			).toBe(true);
	});

	it("refuses an ADR pointer that resolves to no file", () => {
		const out = judge("// ADR-0999\nconst a = 1;\n", "js");
		expect(out.map((b) => b.tag)).toEqual(["ADR-UNRESOLVED"]);
		expect(out[0]?.why).toContain("names no file under docs/adr/");
	});

	it("refuses a Python docstring and a bare string statement", () => {
		expect(
			tags('"""Module doc."""\ndef f():\n    """Doc."""\n    "aside"\n', "py"),
		).toEqual(["COMMENT@1", "COMMENT@3", "COMMENT@4"]);
	});
});

describe("what is not a comment", () => {
	it("passes tool directives that suppress nothing", () => {
		expect(
			tags(
				"#!/usr/bin/env bash\n# shellcheck source=scripts/lib/a.sh\n. a.sh\n",
				"sh",
			),
		).toEqual([]);
		expect(tags("// @ts-check\n// @vitest-environment node\n", "js")).toEqual(
			[],
		);
		expect(tags("# -*- coding: utf-8 -*-\nx = 1\n", "py")).toEqual([]);
		expect(
			tags(
				"#!/usr/bin/env bash\n# code-edges loads: failed-files.js\n# code-edges caller: real\nx=1\n",
				"sh",
			),
		).toEqual([]);
		expect(tags("// code-edges loads: cores.json core\nx();\n", "js")).toEqual(
			[],
		);
	});

	it("refuses a code-edges line where the walk reads none (#5512)", () => {
		expect(tags("// code-edges caller: real\nx();\n", "js")).toEqual([
			"COMMENT@1",
		]);
		expect(tags("# code-edges loads: x.py\nx = 1\n", "py")).toEqual([
			"COMMENT@1",
		]);
	});

	it("passes a checker's marker followed by a bare pointer (§X10, §G6)", () => {
		expect(tags("// full-sweep-only: #5492\nconst a = 1;\n", "js")).toEqual([]);
		expect(tags("// cli-args-exempt: #4820\nconst a = 1;\n", "js")).toEqual([]);
		expect(tags("# claude-route-exempt: #5527\nx=1\n", "sh")).toEqual([]);
		expect(
			tags("/*\n * Unbuilt caller: app/reviews/page.tsx (#575)\n */\n", "js"),
		).toEqual([]);
	});

	it("refuses a checker's marker carrying prose", () => {
		expect(
			tags(
				"// full-sweep-only: reads every tracked file\nconst a = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1"]);
		expect(tags("// Unbuilt caller: later #5\nconst a = 1;\n", "js")).toEqual([
			"COMMENT@1",
		]);
		expect(
			tags("// cli-args-exempt: a pass-through\nconst a = 1;\n", "js"),
		).toEqual(["COMMENT@1"]);
	});

	it("reads a line opening on an adopter's declared marker as code (#5709)", () => {
		const stamps = { commentMarkers: ["@encodes"] };
		expect(
			tags(
				"/*\n * @encodes docs/a.md § 7. The band :: e8d10a0f\n * @encodes docs/a.md § B :: 7c89\n */\nconst a = 1;\n",
				"js",
				stamps,
			),
		).toEqual([]);
		expect(
			tags("# @encodes docs/a.md § B :: 7c89\nx=1\n", "sh", stamps),
		).toEqual([]);
		expect(
			tags(
				"/*\n * The band.\n *\n * @encodes docs/a.md § B :: 7c89\n */\n",
				"js",
				stamps,
			),
		).toEqual(["COMMENT@1"]);
	});

	it("judges a suppression declared as a marker as a suppression still", () => {
		expect(
			tags(
				"// biome-ignore lint/suspicious/noExplicitAny\nconst a = 1;\n",
				"js",
				{
					commentMarkers: ["biome-ignore"],
				},
			),
		).toEqual(["SUPPRESSION@1"]);
	});

	it("reads a declared marker as code only as the line's first word, and an undeclared one never", () => {
		const stamps = { commentMarkers: ["@encodes"] };
		expect(
			tags("// @encodesx docs/a.md\nconst a = 1;\n", "js", stamps),
		).toEqual(["COMMENT@1"]);
		expect(
			tags("// see @encodes docs/a.md\nconst a = 1;\n", "js", stamps),
		).toEqual(["COMMENT@1"]);
		expect(
			tags("// @encodes docs/a.md § B :: 7c89\nconst a = 1;\n", "js"),
		).toEqual(["COMMENT@1"]);
	});

	it("refuses an exempt marker no checker registers (#5540)", () => {
		expect(tags("// foo-exempt: #1\nconst a = 1;\n", "js")).toEqual([
			"COMMENT@1",
		]);
		expect(tags("// jsonl-read-exempt: #4019\nconst a = 1;\n", "js")).toEqual(
			[],
		);
	});

	it("reads a guard's DENIES-THROUGH line as code, and refuses one carrying prose", () => {
		expect(tags("// DENIES-THROUGH: lib/guard-judge.js\nx();\n", "js")).toEqual(
			[],
		);
		expect(
			tags("// DENIES-THROUGH: lib/guard-judge.js, its judge\nx();\n", "js"),
		).toEqual(["COMMENT@1"]);
	});

	it("reads the hook-shim mark as code in a shell file alone", () => {
		expect(tags("# workflow-core hook shim:\nset -e\n", "sh")).toEqual([]);
		expect(tags("// workflow-core hook shim:\nconst a = 1;\n", "js")).toEqual([
			"COMMENT@1",
		]);
	});

	it("reads no comment inside a string, a template, a regex or a heredoc", () => {
		expect(
			tags("const a = '// no', b = `/* no */`, c = /\\/\\/ no/;\n", "js"),
		).toEqual([]);
		expect(tags('s = "# no"\nt = """\n# no\n"""\nu = 1\n', "py")).toEqual([]);
		expect(
			tags(
				`echo "a # no" '# no' $# \${#x} a#b\ncat <<'EOF'\n# no\nEOF\n# yes\n`,
				"sh",
			),
		).toEqual(["COMMENT@5"]);
	});

	it("reads quotes nested in a command substitution inside a double quote (#5526)", () => {
		expect(
			tags(
				`r="$(grep -F "\\"n\\":\\"$(esc "$n")\\"" f |\n  sed -n 's/"\\([^"]*\\)"/\\1/p')"\necho "a (#1) b" >>out\n# yes\n`,
				"sh",
			),
		).toEqual(["COMMENT@4"]);
	});

	it("reads a here-string as no heredoc, so the comments after it are judged (#5526)", () => {
		expect(tags('read -ra f <<<"$rest"\n# yes\n', "sh")).toEqual(["COMMENT@2"]);
	});
});

describe("langOf", () => {
	it("reads the language from the extension, or a shell shebang", () => {
		expect(langOf("a/b.ts", "")).toBe("js");
		expect(langOf("a/b.mjs", "")).toBe("js");
		expect(langOf("a/b.py", "")).toBe("py");
		expect(langOf(".husky/pre-commit", "#!/usr/bin/env sh\n")).toBe("sh");
		expect(langOf("Makefile", "all:\n")).toBeNull();
		expect(langOf("docs/a.md", "")).toBeNull();
	});
});
