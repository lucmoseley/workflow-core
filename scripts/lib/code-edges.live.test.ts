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

const GUARD_CORES = path.join(ROOT, "scripts/lib/guard-cores.json");

const files = Object.entries(DECLARING).map(([rel, at]) => ({
	rel,
	at,
	text: fs.readFileSync(at, "utf8"),
	lines: readMarkerLines(at),
}));

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
