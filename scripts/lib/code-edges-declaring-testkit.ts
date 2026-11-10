/*
 * The live tree's `code-edges loads:` and `code-edges caller:` lines
 * (lib/code-edges.js, #4790), for code-edges' two live-repo tests: the files
 * holding one, and each line naming the marker, read by `reachOf` itself
 * rather than by a copy of its pragmas.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { reachOf } = require("./code-edges.js");

export const ROOT = path.resolve(__dirname, "..", "..");

/* The marker both pragmas open on, group 1 the kind; git grep reads it too. */
export const MARKER = /code-edges (loads|caller): /;

/* Every file in the repo holding a declaration, each spelled whole so a
 * change to it selects the tests reading it. */
export const DECLARING: Record<string, string> = {
	"scripts/lib/guard-core-load.js": path.join(
		ROOT,
		"scripts/lib/guard-core-load.js",
	),
	"scripts/lib/guard-judge.js": path.join(ROOT, "scripts/lib/guard-judge.js"),
	"scripts/lib/host-git-guard/git": path.join(
		ROOT,
		"scripts/lib/host-git-guard/git",
	),
	"vitest.setup.ts": path.join(ROOT, "vitest.setup.ts"),
};

/** The walk's answer for the file at `at` holding `text`. */
export const reach = (at: string, text: string) =>
	reachOf(at, text, () => undefined);

/**
 * One line naming the marker: its kind, the words after the marker, the
 * file's text without it, and whether `reachOf` reads it as a declaration,
 * its answer for the file changing when the line goes.
 */
export interface MarkerLine {
	line: string;
	kind: "loads" | "caller";
	words: string[];
	without: string;
	isDeclaration: boolean;
}

/**
 * Every line naming the marker in the file at `at`, its working-tree text.
 * @param at absolute
 */
export function markerLines(at: string): MarkerLine[] {
	const text = fs.readFileSync(at, "utf8");
	const whole = JSON.stringify(reach(at, text));
	const lines = text.split("\n");
	return lines.flatMap((line, i) => {
		const m = MARKER.exec(line);
		if (!m) return [];
		const without = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n");
		return [
			{
				line,
				kind: m[1] === "caller" ? "caller" : "loads",
				words: line
					.slice((m.index ?? 0) + m[0].length)
					.trim()
					.split(/\s+/),
				without,
				isDeclaration: JSON.stringify(reach(at, without)) !== whole,
			},
		];
	});
}
