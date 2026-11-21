// @vitest-environment node
/*
 * Judges each shape (#5455, #5477, #5490) on judgeSource alone, so a
 * shape's verdict is read without a git repo. A shape that drifts here
 * refuses a permitted comment, or lets prose through, in every adopter's
 * commit once the module is on.
 */

import { describe, expect, it } from "vitest";
import { depsPattern, judgeSource, langOf } from "./comment-policy.js";

type Lang = "js" | "py" | "sh";

const facts = (lang: Lang, over: Record<string, unknown> = {}) => ({
	lang,
	checkJs: true,
	exports: new Set<string>(),
	shipped: false,
	adrs: new Set(["0010"]),
	deps: depsPattern(["vitest", "@biomejs/biome"]),
	styleOnly: {
		biome: ["format", "lint/style"],
		ruff: ["E5", "PLR09"],
	} as Record<string, string[]>,
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
		expect(tags("/* vitest runs it twice */\nconst a = 1;\n", "js")).toEqual(
			[],
		);
		expect(tags("// biome sorts these\nconst a = 1;\n", "js")).toEqual([]);
	});

	it("passes a doc on an export the helper surface lists, or a shipped file's header (K4)", () => {
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
			tags("/* What adopters import. */\nconst a = 1;\n", "js", {
				shipped: true,
			}),
		).toEqual([]);
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

	it("judges the prose beside a suppression on its own", () => {
		expect(
			tags(
				"// why the rule is wrong here\n// biome-ignore lint/style/noX: ok\nconst a = 1;\n",
				"js",
			),
		).toEqual(["COMMENT@1"]);
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
