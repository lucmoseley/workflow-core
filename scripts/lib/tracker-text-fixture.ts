/*
 * tracker-text-fixture.ts — a stand-in lib/tracker-inject-text.js for the
 * context-budget suites, whose injection union is exactly the header a case
 * names (#5151).
 *
 * Every part check-context-budget.js sums is exported empty but the header;
 * `extra` adds or overrides properties, as JS source inside the exports
 * object. The union also reads two rule fragments directly, which the core's
 * store would answer where the fixture root has none, so writeTextModule()
 * plants them empty.
 */

import fs from "node:fs";
import path from "node:path";

/** Where the checker reads the text module, relative to the root. */
export const TEXT_MODULE = "scripts/lib/tracker-inject-text.js";

/* The fragments the union reads as parts of their own. */
const UNION_FRAGMENTS = [
	"review-deviations-read",
	"review-finding-destination",
];

/**
 * A text module's source whose union is `header`'s bytes plus whatever
 * `extra` adds.
 * @param header what `header()` returns for every command
 * @param extra further exports, as `name: value,` JS source
 */
export function textModuleSource(header: string, extra = ""): string {
	return [
		`const HEADER = ${JSON.stringify(header)};`,
		"module.exports = {",
		'\tCOMMANDS: ["implement", "triage"],',
		"\tTAKES_READ: [],",
		'\ttakesLine: () => "",',
		"\theader: () => HEADER,",
		'\tWAYFINDER_CLAUSES: "",',
		"\tINDEX: {},",
		'\ttrackerIndex: () => "",',
		"\tCLOSING_STEPS: {},",
		'\tPRICED_OPTIONS_POINTER: "",',
		"\tcodeReviewParts: () => [],",
		extra,
		"};",
		"",
	].join("\n");
}

/**
 * Writes `source` as the text module under `root`, and the union's fragments
 * empty beside it. Returns the module's path.
 */
export function writeTextModule(root: string, source: string): string {
	const file = path.join(root, TEXT_MODULE);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
	const rules = path.join(root, "docs", "agents", "rules");
	fs.mkdirSync(rules, { recursive: true });
	for (const id of UNION_FRAGMENTS)
		fs.writeFileSync(path.join(rules, `${id}.txt`), "");
	return file;
}
