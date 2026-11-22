// @vitest-environment node

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

const codeOf = (text: string) =>
	text
		.split("\n")
		.filter((l) => !COMMENT_LINE.test(l))
		.join("\n");

function loadedModules(at: string, text: string): string[] {
	const seen = new Set<string>();
	const queue = [{ at, text }];
	for (let next = queue.pop(); next; next = queue.pop())
		for (const edge of reach(next.at, next.text).edges) {
			if (seen.has(edge) || edge.endsWith(".json")) continue;
			if (!fs.existsSync(edge) || !fs.statSync(edge).isFile()) continue;
			seen.add(edge);
			queue.push({ at: edge, text: fs.readFileSync(edge, "utf8") });
		}
	return [...seen];
}

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
	"%s names a target its file's code still spells, itself or its directory, or a module it loads spells by name",
	(_name, { at }, { without, words: [target = ""] }) => {
		const code = codeOf(without);
		const spellings = [target, path.dirname(target)].filter((t) => t !== ".");
		const absolute = path.resolve(path.dirname(at), target);
		const name = path.basename(target);
		const spelt =
			spellings.some((t) => code.includes(t)) ||
			loadedModules(at, without)
				.filter((m) => m !== absolute)
				.some((m) => codeOf(fs.readFileSync(m, "utf8")).includes(name));
		expect(spelt).toBe(true);
	},
);
