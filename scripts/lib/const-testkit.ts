/*
 * const-testkit.ts — a figure a shell or Node file spells, read where it is
 * spelled, so a test never holds a second copy of it (#1748).
 *
 * Callers pass the path composed at the call site, `path.join(__dirname, …)`,
 * so the read-edge extractor still attributes the read file to the test.
 * Both readers throw where `file` holds no such line.
 */

import fs from "node:fs";
import { escapeRe } from "./regex-group.js";

/** The integer `file`'s column-zero line `<before><n><after>` spells. Throws
 *  where none does, so a renamed constant fails loudly rather than as NaN. */
function readConst(file: string, before: string, after: string): number {
	const found = new RegExp(
		`^${escapeRe(before)}(\\d+)${escapeRe(after)}$`,
		"m",
	).exec(fs.readFileSync(file, "utf8"))?.[1];
	if (found === undefined)
		throw new Error(`no ${before}<n>${after} line in ${file}`);
	return Number(found);
}

/** The integer a `<name>=<n>` line at column zero of `file` assigns. */
export const readShellConst = (file: string, name: string): number =>
	readConst(file, `${name}=`, "");

/** The integer a `const <name> = <n>;` line at column zero of `file`
 *  assigns, for a constant its module keeps file-local. */
export const readJsConst = (file: string, name: string): number =>
	readConst(file, `const ${name} = `, ";");
