/*
 * citation-write.js — the dispatcher core that names a `Write` or `Edit`
 * adding a `mantahostels#N` the inherited tracker never used, as it lands, and
 * hands the session the citation rule (#2015, spec #1996).
 *
 * The test is lib/citation-tracker.js's, the one the pre-commit gate
 * (check-citation-tracker.js) refuses on. The rule left the always-loaded
 * pool for this core (#1942); the gate alone speaks only after the file is
 * written.
 *
 * LIMITS
 *  - INJECTION ONLY: it never refuses.
 *  - A citation written through Bash, or by NotebookEdit, is never seen.
 *  - It judges the decidable half alone: a number BOTH trackers used passes.
 *  - It is silent in an adopter, where `ec8654cd` does not resolve.
 *  - A git fault allows the write, logged (mantahostels#147).
 */

const {
	PREFIX,
	baselineRev,
	judgeLine,
	readBaselineCommit,
	readInheritedNumbers,
} = require("./citation-tracker.js");

/** How much of git's complaint the log keeps: the bash guard's 300, never derived. */
const WHY_CHARS = 300;

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
 */

/**
 * The lines a write adds: those of the new text the text it replaces does not
 * already carry — `old_string` for an `Edit`, the file on disk for a `Write`
 * — so a write that only moves an old citation is not judged for it.
 * @param {string} rel
 * @param {CoreContext} ctx
 */
function addedLines(rel, ctx) {
	const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
	const edit = ctx.tool === "Edit";
	const before = edit ? text(ctx.input.old_string) : (ctx.readText(rel) ?? "");
	const after = text(edit ? ctx.input.new_string : ctx.input.content);
	const had = new Set(before.split("\n"));
	return after.split("\n").filter((l) => !had.has(l));
}

/**
 * @param {string} file the path the write names
 * @param {CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	const written = ctx.input.content ?? ctx.input.new_string;
	if (typeof written !== "string" || !written.includes(`${PREFIX}#`))
		return null;
	const rel = ctx.repoRel(file);
	if (rel === null) return null;
	const lines = addedLines(rel, ctx).filter((l) => l.includes(`${PREFIX}#`));
	if (lines.length === 0) return null;
	const rev = baselineRev(ctx.env);
	const baseline = readBaselineCommit(ctx.git, rev);
	if (!baseline.ok) return unjudged(rel, baseline.why, ctx);
	if (baseline.sha === null) return null;
	const inherited = readInheritedNumbers(ctx.git, rev);
	if (!inherited.ok) return unjudged(rel, inherited.why, ctx);
	/** @type {Set<number>} */
	const found = new Set();
	for (const line of lines)
		for (const n of judgeLine({ file: rel, line }, inherited.out).found)
			found.add(n);
	if (found.size === 0) return null;
	const named = [...found]
		.sort((a, b) => a - b)
		.map((n) => `${PREFIX}#${n} (write #${n})`)
		.join(" ");
	return {
		prelude: `${rel} adds ${named} — the inherited tracker never used that number, so the citation means this repo's own issue.`,
		injectRules: ["citation-tracker"],
	};
}

/**
 * @param {string} rel
 * @param {string} why
 * @param {CoreContext} ctx
 * @returns {null}
 */
function unjudged(rel, why, ctx) {
	ctx.log(
		`git did not judge ${rel} (${why.slice(0, WHY_CHARS)}) — citation rule not injected`,
	);
	return null;
}

module.exports = { field: "file_path", noun: "write", decide };
