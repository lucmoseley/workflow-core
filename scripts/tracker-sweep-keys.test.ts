// @vitest-environment node
// full-sweep-only: #1886

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_CHECKS } from "./lib/repo-checks-registry";

const ROOT = path.resolve(__dirname, "..");

const scriptsJudged = (): string[] =>
	[
		...new Set(
			REPO_CHECKS.filter((e) => e.kind === "check").map(
				(e) => `scripts/${e.script}`,
			),
		),
	].sort();

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
	return ["", ","].includes(last) ? commas : commas + 1;
}

function closingQuote(source: string, from: number, quote: string): number {
	let i = from;
	for (; i < source.length; i++) {
		if (source[i] === "\\") i++;
		else if (source[i] === quote) return i;
	}
	return i;
}

function indirectRaises(source: string): number {
	return [...source.matchAll(/\bctx\.(?:fail|warn)\b(?!\s*\()/g)].filter(
		(m) => !onCommentLine(source, m.index),
	).length;
}

function onCommentLine(source: string, at: number): boolean {
	const lineStart = source.lastIndexOf("\n", at) + 1;
	return /^\s*(?:\/\/|\/\*|\*)/.test(source.slice(lineStart, at));
}

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
		// #1591 measured 22 checks; the floor's slack is a guess
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
