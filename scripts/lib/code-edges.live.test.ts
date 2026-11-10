// @vitest-environment node
/*
 * The live tree's `code-edges loads:` and `code-edges caller:` lines
 * (lib/code-edges.js, #4790): each is a file's word for what a load the walk
 * cannot read loads, which a later edit may leave stale. Each one in the repo
 * must be a line the walk reads, name files that exist, and explain what it
 * declares; break one and the pass store caches a test on an input it never
 * read. A `caller:` line, or a `loads:` line with a key, explains a load the
 * walk would otherwise hold unread. A keyless `loads:` line declares a load
 * the walk cannot see at all (vitest.setup.ts puts the git shim on `PATH`),
 * so its case holds only that the file's code still spells the target or
 * its directory. Which files hold one is code-edges.inventory.live.test.ts's.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
	DECLARING,
	ROOT,
	reach,
	readMarkerLines,
} from "./code-edges-declaring-testkit";

/* The manifest the keyed lines name, read two hops in: guard-core-load.js's
 * declaration, then the cores its `core` values name. */
const GUARD_CORES = path.join(ROOT, "scripts/lib/guard-cores.json");

const files = Object.entries(DECLARING).map(([rel, at]) => ({
	rel,
	at,
	text: fs.readFileSync(at, "utf8"),
	lines: readMarkerLines(at),
}));

/* A comment line, which a keyless line's target must be spelled outside. */
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*|#)/;

it.each(files.map((f) => [f.rel, f]))(
	"%s holds a declaration, and its declarations name files that exist and leave no load unread",
	(_rel, { at, text, lines }) => {
		expect(lines.length).toBeGreaterThan(0);
		expect(reach(at, text).unread).toEqual([]);
	},
);

it("holds guard-cores.json, the keyed lines' manifest, as a read", () => {
	const core = DECLARING["scripts/lib/guard-core-load.js"] ?? "";
	expect(reach(core, fs.readFileSync(core, "utf8")).reads).toEqual([
		GUARD_CORES,
	]);
});

const declared = files.flatMap((f) =>
	f.lines.map((l) => [`${f.rel}: ${l.line.trim()}`, f, l] as const),
);

it.each(declared)(
	"%s is a line the walk reads",
	(_name, _file, { isDeclaration }) => {
		expect(isDeclaration).toBe(true);
	},
);

it.each(
	declared.filter(([, , l]) => l.kind === "caller" || l.words.length > 1),
)(
	"%s explains a load the walk would otherwise hold unread",
	(_name, { at }, { without }) => {
		expect(reach(at, without).unread.length).toBeGreaterThan(0);
	},
);

it.each(
	declared.filter(([, , l]) => l.kind === "loads" && l.words.length === 1),
)(
	"%s names a target its file's code still spells, itself or its directory",
	(_name, _file, { without, words: [target = ""] }) => {
		const code = without
			.split("\n")
			.filter((l) => !COMMENT_LINE.test(l))
			.join("\n");
		const spellings = [target, path.dirname(target)].filter((t) => t !== ".");
		expect(spellings.some((t) => code.includes(t))).toBe(true);
	},
);
