/*
 * The lib/ collectors (`readRequiredLibs`, `readProgramLibs`) and their copier
 * `copyLibs`, which any test copying a script into a detached fixture uses
 * (#2256, #2272).
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { requiredGroup }: typeof import("./lib/regex-group.js") = createRequire(
	import.meta.url,
)("./lib/regex-group.js");

const SIBLING_REQUIRE = /require\("\.\/([^"]+)"\)/g;
const PROGRAM_LIB_REQUIRE = /require\("\.\/lib\/([^"]+)"\)/g;

/**
 * The lib/ files `text` requires through `pattern`, as .js filenames. A name
 * with no file is skipped, as a comment's `require("./lib/x")` is; a real
 * require of one fails the fixture's run as MODULE_NOT_FOUND.
 */
const requiresOf = (pattern: RegExp) => (text: string) =>
	[...text.matchAll(pattern)]
		.map((m) => {
			const name = requiredGroup(m, 1, pattern);
			return name.endsWith(".js") ? name : `${name}.js`;
		})
		.filter((lib) => fs.existsSync(path.resolve(__dirname, "lib", lib)));

/**
 * `entry` and every lib/ file it requires, transitively, as bare filenames.
 */
const readRequiredLibs = (entry: string): string[] => [
	entry,
	...readLibClosure(
		fs.readFileSync(path.resolve(__dirname, "lib", entry), "utf8"),
		requiresOf(SIBLING_REQUIRE),
	).filter((lib) => lib !== entry),
];

/**
 * Every lib/ file a scripts/ program requires, transitively, as bare
 * filenames: what a plugin-install fixture copies beside `program`, which is
 * left out (#2256). Reads only the double-quoted `require("./lib/…")` form
 * Biome writes; a miss fails the fixture's run as MODULE_NOT_FOUND.
 */
export const readProgramLibs = (program: string): string[] => [
	...new Set(
		requiresOf(PROGRAM_LIB_REQUIRE)(
			fs.readFileSync(path.resolve(__dirname, program), "utf8"),
		).flatMap(readRequiredLibs),
	),
];

export const copyLibs = (
	dest: string,
	libs: string[],
	omit: string[] = [],
): void => {
	fs.mkdirSync(dest, { recursive: true });
	for (const lib of libs.filter((l) => !omit.includes(l)))
		fs.copyFileSync(path.resolve(__dirname, "lib", lib), path.join(dest, lib));
};

/** Every lib/ file reachable from `text` through `named`, read from lib/. */
const readLibClosure = (text: string, named: (text: string) => string[]) => {
	const out = new Set<string>();
	const queue = named(text);
	for (let lib = queue.shift(); lib !== undefined; lib = queue.shift()) {
		if (out.has(lib)) continue;
		out.add(lib);
		queue.push(
			...named(fs.readFileSync(path.resolve(__dirname, "lib", lib), "utf8")),
		);
	}
	return [...out];
};
