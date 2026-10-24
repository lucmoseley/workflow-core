// @vitest-environment node
/*
 * mantahostels#2490's second acceptance criterion, made checkable: every finding raised by
 * a check the daily repo-checks run judges
 * (scripts/lib/repo-checks-registry.js, #1557) carries an explicit key.
 *
 * WHY IT NEEDS A TEST OF ITS OWN. lib/check.js falls back to tag-and-message
 * where a checker keys nothing, so an unkeyed finding is NOISY rather than
 * silent — the reader reports churn instead of losing an addition. That is the
 * safe way round, and it is also invisible: nothing else here would ever fail
 * because a checker forgot. This is what fails, in CI.
 *
 * The scan is LEXICAL: it matches `ctx.fail(` / `ctx.warn(`, walks brackets to
 * the closing paren, and counts top-level arguments. It reads the checkers'
 * source rather than running them because a run raises only the findings
 * today's tree provokes, and every raise must carry its key, the ones that
 * never fire included. So a call assembled
 * dynamically, or spelled through an alias, is unseen — that residual is why
 * the fallback exists rather than a refusal in lib/check.js.
 *
 * full-sweep-only: reads each checker the repo-checks registry names, a set
 * read from the registry at runtime, so no literal names them.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_CHECKS } from "./lib/repo-checks-registry";

const ROOT = path.resolve(__dirname, "..");

/** Every check the daily run judges by key set: each that speaks `--json`. */
const scriptsJudged = (): string[] =>
	[
		...new Set(
			REPO_CHECKS.filter((e) => e.kind === "check").map(
				(e) => `scripts/${e.script}`,
			),
		),
	].sort();

/**
 * Every `ctx.fail(…)` / `ctx.warn(…)` call in `source`, and every
 * `ctx[severity](…)` that picks between them, as the number of top-level
 * arguments it passes. A match on a comment line is prose, not a raise.
 *
 * `callee` must consume the opening paren: the bracket walk below starts at
 * depth 1 and counts from there.
 */
function findingArities(
	source: string,
	callee = /\bctx(?:\.(?:fail|warn)|\[\w+\])\(/g,
): { at: number; args: number }[] {
	const out: { at: number; args: number }[] = [];
	for (const m of source.matchAll(callee))
		if (!onCommentLine(source, m.index))
			out.push({
				at: m.index,
				args: topLevelArgs(source, m.index + m[0].length),
			});
	return out;
}

/** How many top-level arguments a call passes, its open paren ending at `from`. */
function topLevelArgs(source: string, from: number): number {
	let depth = 1;
	let commas = 0;
	let last = "";
	for (let i = from; i < source.length; i++) {
		const c = source[i];
		if (c === '"' || c === "'" || c === "`") i = closingQuote(source, i + 1, c);
		else if ("([{".includes(c)) depth++;
		else if (")]}".includes(c) && --depth === 0) break;
		else if (c === "," && depth === 1) commas++;
		if (!/\s/.test(c)) last = c;
	}
	// A trailing comma opens no argument: Biome adds one to every call it wraps.
	return ["", ","].includes(last) ? commas : commas + 1;
}

/** Where the `quote` opened just before `from` closes, or past the end. */
function closingQuote(source: string, from: number, quote: string): number {
	let i = from;
	for (; i < source.length; i++) {
		if (source[i] === "\\") i++;
		else if (source[i] === quote) return i;
	}
	return i;
}

/**
 * Every place `ctx.fail` / `ctx.warn` is referred to WITHOUT being called on the
 * spot — passed as a value, bound, aliased.
 *
 * The scanner above cannot judge these: the arguments are supplied at the call
 * site of whatever received the reference. check-large-scale-trigger.js raises
 * through `ctx.fail.bind(ctx)` and so passed the arity test vacuously, which is
 * the fault mantahostels#2490's review found.
 *
 * WHAT THE DECLARATION BUYS. Requiring an entry below makes the indirection
 * VISIBLE — a new one cannot arrive unnoticed — and the entry names the
 * PARAMETER the raise arrives as, which the case below counts arguments on
 * (mantahostels#2589).
 *
 * WHAT IT STILL DOES NOT BUY. The count is a count: a helper passing four
 * arguments of which the fourth is `undefined` reads as keyed.
 */
function indirectRaises(source: string): number {
	return [...source.matchAll(/\bctx\.(?:fail|warn)\b(?!\s*\()/g)].filter(
		(m) => !onCommentLine(source, m.index),
	).length;
}

/** Whether the line holding `at` opens as a comment — `//`, `/*` or a JSDoc `*`. */
function onCommentLine(source: string, at: number): boolean {
	const lineStart = source.lastIndexOf("\n", at) + 1;
	return /^\s*(?:\/\/|\/\*|\*)/.test(source.slice(lineStart, at));
}

/**
 * Checkers that raise through a helper — handed `ctx.fail`/`ctx.warn`, or
 * wrapping one.
 *
 * `param` is the name the helper is called by — the call the key must be
 * supplied at.
 */
const INDIRECT: Record<string, { param: string; note: string }> = {
	"scripts/check-instruction-surface.js": {
		param: "raise",
		note: "wraps ctx.warn to print each finding as it is raised",
	},
};

describe("the argument scanner", () => {
	it("counts top-level arguments, ignoring nested calls and literals", () => {
		expect(
			findingArities(`ctx.fail("T", \`a, b\`, { x: [1, 2] }, "k")`),
		).toEqual([{ at: 0, args: 4 }]);
	});

	it("counts a three-argument call as three", () => {
		expect(findingArities(`ctx.warn("T", msg, i)`)[0].args).toBe(3);
	});

	it("reads a computed severity as a raise, and a comment line as none", () => {
		expect(
			findingArities("ctx[severity](tag, msg, data)\n * ctx.fail(x)"),
		).toEqual([{ at: 0, args: 3 }]);
	});

	it("counts a wrapped call's trailing comma as no argument", () => {
		expect(findingArities(`ctx.warn(\n\t"T",\n\tmsg,\n\ti,\n)`)[0].args).toBe(
			3,
		);
	});
});

describe("every finding a judged check raises carries a key", () => {
	const scripts = scriptsJudged();

	it("finds the registry's scripts at all", () => {
		// A rename that silently emptied this list would make every case below
		// vacuous. 22 at #1591; the slack lets a check or two retire unremarked.
		expect(scripts.length).toBeGreaterThanOrEqual(20);
	});

	for (const script of scripts) {
		it(script, () => {
			const source = fs.readFileSync(path.join(ROOT, script), "utf8");
			const unkeyed = findingArities(source).filter((f) => f.args < 4);
			expect(
				unkeyed.map(
					(f) => `${script}: ${source.slice(f.at, f.at + 60).split("\n")[0]}`,
				),
			).toEqual([]);
		});

		/* Without this the case above is vacuous for any checker that routes its
		 * raises through a helper — it simply finds no calls and passes. */
		it(`${script} — indirect raises are declared`, () => {
			const source = fs.readFileSync(path.join(ROOT, script), "utf8");
			const undeclared =
				indirectRaises(source) > 0 && !INDIRECT[script] ? [script] : [];
			expect(undeclared).toEqual([]);
		});
	}

	for (const [script, { param }] of Object.entries(INDIRECT)) {
		it(`${script} — its helper still forwards a key`, () => {
			const source = fs.readFileSync(path.join(ROOT, script), "utf8");
			const calls = findingArities(
				source,
				new RegExp(`(?<![\\w.$])${param}\\(`, "g"),
			);
			// No call at all means the declared parameter has been renamed, which
			// would leave the arity assertion below vacuously true.
			expect(calls.length).toBeGreaterThan(0);
			expect(calls.filter((c) => c.args < 4)).toEqual([]);
		});
	}

	it("every INDIRECT entry names a script the workflow still runs", () => {
		expect(Object.keys(INDIRECT).filter((s) => !scripts.includes(s))).toEqual(
			[],
		);
	});
});
