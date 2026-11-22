const { CITATION_CEILING } = require("./qualify-citations.js");
const { gitOutcome } = require("./git.js");
const { readCommit } = require("./commit-sha.js");

/** @typedef {import("./git.js").GitReader} GitReader */

const baselineRev = (env = process.env) =>
	env.WFC_CITATION_BASELINE || "ec8654cd";

const PREFIX = "mantahostels";

const BAND_MAX = CITATION_CEILING;

const CITE = new RegExp(`${PREFIX}#(\\d+)`, "g");

const OWNER = "lucmoseley";

const OWNED_CITE = new RegExp(
	`(?:(?<![\\w.-])(?<owner>[\\w.-]+)/)?${PREFIX}#(?<n>\\d+)`,
	"g",
);

const INHERITED_UNCITED = new Set([
	78,
	// #726
	1459, 2313, 2557, 2586, 3509, 3519, 3527, 3566, 3570, 3592, 3605, 3631,
	// #1938
	1248, 2036,
	// #1947
	932, 1765, 3096,
]);

const DECLARED_EXTERNAL = /"ref":\s*"mantahostels#\d+"/;

const SELF_TEST = "scripts/check-citation-tracker.test.ts";

const EXEMPT = /citation-exempt:[ \t]*[A-Za-z0-9]/;

/**
 * @param {GitReader} [read]
 * @param {string} [rev]
 */
function readBaselineCommit(read = gitOutcome, rev = baselineRev()) {
	return readCommit(read, rev);
}

/**
 * @param {GitReader} [read]
 * @param {string} [rev]
 * @returns {{ ok: true, out: Set<number> } | { ok: false, why: string }}
 */
function readInheritedNumbers(read = gitOutcome, rev = baselineRev()) {
	const r = read(
		["grep", "-oh", "-E", `${PREFIX}#[0-9]+`, rev, "--", "."],
		[1],
	);
	if (!r.ok) return r;
	const seen = new Set();
	for (const m of r.out.matchAll(CITE)) seen.add(Number(m[1]));
	return { ok: true, out: seen };
}

/**
 * @param {{file: string, line: string}} at
 * @param {Set<number>} inherited
 * @returns {{citations: number, found: number[]}}
 */
function judgeLine({ file, line }, inherited) {
	/** @type {number[]} */
	const found = [];
	if (file.startsWith(SELF_TEST)) return { citations: 0, found };
	if (DECLARED_EXTERNAL.test(line) || EXEMPT.test(line))
		return { citations: 0, found };
	let citations = 0;
	for (const m of line.matchAll(OWNED_CITE)) {
		if (m.groups?.owner === OWNER) continue;
		const n = Number(m.groups?.n);
		if (n > BAND_MAX) continue;
		citations++;
		if (inherited.has(n) || INHERITED_UNCITED.has(n)) continue;
		found.push(n);
	}
	return { citations, found };
}

module.exports = {
	PREFIX,
	baselineRev,
	readBaselineCommit,
	readInheritedNumbers,
	judgeLine,
};
