// @vitest-environment node
/*
 * The live tree's `code-edges loads:` and `code-edges caller:` lines
 * (lib/code-edges.js, #4790): each is a file's word for what a load the walk
 * cannot read loads, which a later edit may leave stale. Each one in the repo
 * must name files that exist and explain a load the walk would otherwise
 * hold unread; break one and the pass store caches a test on an input it
 * never read.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { reachOf } = require("./code-edges.js");

const ROOT = path.resolve(__dirname, "..", "..");

/* A declaration line, as code-edges.js's LOADS_PRAGMA and SH_CALLER_PRAGMA
 * read one: group 1 the kind, group 2 what it names. */
const DECLARATION =
	/^[ \t]*(?:\/\/|\/?\*|#)[ \t]*code-edges (loads|caller): (\S+(?:[ \t]+\S+)*)[ \t]*$/gm;

/* Every file in the repo holding a declaration, each spelled whole so a
 * change to it selects this test. */
const DECLARING: Record<string, string> = {
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

const files = Object.entries(DECLARING).map(([rel, at]) => {
	const text = fs.readFileSync(at, "utf8");
	const lines = [...text.matchAll(DECLARATION)].map((m) => ({
		line: m[0],
		named: m[2] ?? "",
	}));
	return { rel, at, text, lines };
});

const reach = (at: string, text: string) => reachOf(at, text, () => undefined);

it("knows every file in the repo holding a declaration", () => {
	const holding = execFileSync(
		"git",
		["grep", "-l", "-E", "code-edges (loads|caller): "],
		{ cwd: ROOT, encoding: "utf8" },
	)
		.split("\n")
		.filter((rel) => rel !== "" && !(rel in DECLARING))
		.filter(
			(rel) =>
				execFileSync("git", ["show", `:${rel}`], {
					cwd: ROOT,
					encoding: "utf8",
				}).match(DECLARATION) !== null,
		);
	expect(holding).toEqual([]);
	for (const f of files) expect(f.lines.length).toBeGreaterThan(0);
});

it.each(files.map((f) => [f.rel, f]))(
	"%s's declarations name files that exist and leave no load unread",
	(_rel, { at, text }) => {
		expect(reach(at, text).unread).toEqual([]);
	},
);

it.each(
	files.flatMap((f) =>
		f.lines.map((l) => [`${f.rel}: ${l.line.trim()}`, f, l] as const),
	),
)("%s explains what it declares", (_name, { at, text }, { line, named }) => {
	const without = reach(at, text.replace(line, ""));
	const [target, key] = named.split(/\s+/);
	if (line.includes("caller:") || key !== undefined)
		expect(without.unread.length).toBeGreaterThan(0);
	else
		expect(reach(at, text).edges).toContain(
			path.join(path.dirname(at), target ?? ""),
		);
});
