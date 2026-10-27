/*
 * shell-const-testkit.ts — a figure a shell file spells, read where it is
 * spelled, so a test never holds a second copy of it (#1748).
 *
 * Callers pass the path composed at the call site, `path.join(__dirname, …)`,
 * so the read-edge extractor still attributes the shell file to the test.
 */

import fs from "node:fs";

/** The integer a `<name>=<n>` line at column zero of `file` assigns. Throws
 *  where none does, so a renamed constant fails loudly rather than as NaN. */
export function readShellConst(file: string, name: string): number {
	const found = new RegExp(`^${name}=(\\d+)$`, "m").exec(
		fs.readFileSync(file, "utf8"),
	)?.[1];
	if (found === undefined) throw new Error(`no ${name}=<n> line in ${file}`);
	return Number(found);
}
