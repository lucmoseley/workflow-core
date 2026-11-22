// @vitest-environment node
// full-sweep-only: #5553

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

const codeOf = (text: string) =>
	text
		.split("\n")
		.filter((l) => !COMMENT_LINE.test(l))
		.join("\n");

const QUOTED = /["'`]([^"'`\s]+)["'`]/g;

/* #5553 measured: the deepest live loader, core-hooks.js, sits 2 imports in. */
const LOADER_HOPS = 2;

function readLoaderSpellings(at: string, text: string, skip: string): string[] {
	const seen = new Set([at, skip]);
	let hop = [{ at, text }];
	const spellings: string[] = [];
	for (let depth = 0; depth < LOADER_HOPS; depth++)
		hop = hop.flatMap((m) =>
			reach(m.at, m.text)
				.edges.filter((e: string) => !seen.has(e) && !e.endsWith(".json"))
				.filter((e: string) => fs.existsSync(e) && fs.statSync(e).isFile())
				.map((e: string) => {
					seen.add(e);
					const loaded = fs.readFileSync(e, "utf8");
					for (const q of codeOf(loaded).matchAll(QUOTED))
						spellings.push(
							(q[1] ?? "").replace(/^.*\}/, "").replace(/^\.?\//, ""),
						);
					return { at: e, text: loaded };
				}),
		);
	return spellings.filter((l) => /[./]/.test(l));
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
	"%s names a target its file's code still spells, itself or its directory, or a module it loads within two imports quotes as a path tail",
	(_name, { at }, { without, words: [target = ""] }) => {
		const code = codeOf(without);
		const spellings = [target, path.dirname(target)].filter((t) => t !== ".");
		const absolute = path.resolve(path.dirname(at), target);
		const fromRoot = path.relative(ROOT, absolute);
		const spelt =
			spellings.some((t) => code.includes(t)) ||
			readLoaderSpellings(at, without, absolute).some(
				(l) => fromRoot === l || fromRoot.endsWith(`/${l}`),
			);
		expect(spelt).toBe(true);
	},
);
