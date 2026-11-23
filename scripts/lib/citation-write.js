const {
	PREFIX,
	baselineRev,
	judgeLine,
	readBaselineCommit,
	readInheritedNumbers,
} = require("./citation-tracker.js");
const { dataOrThrow } = require("./file-read.js");

// guess, #5529
const WHY_CHARS = 300;

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 */

/**
 * @param {string} rel
 * @param {CoreContext} ctx
 * @param {import("./guard-host-ports.js").TreePorts} tree
 */
function addedLines(rel, ctx, tree) {
	const text = (/** @type {unknown} */ v) => (typeof v === "string" ? v : "");
	const edit = ctx.tool === "Edit";
	const before = edit
		? text(ctx.input.old_string)
		: (dataOrThrow(tree.read(rel)) ?? "");
	const after = text(edit ? ctx.input.new_string : ctx.input.content);
	const had = new Set(before.split("\n"));
	return after.split("\n").filter((l) => !had.has(l));
}

/**
 * @param {string} file
 * @param {CoreContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(file, ctx) {
	const written = ctx.input.content ?? ctx.input.new_string;
	if (typeof written !== "string" || !written.includes(`${PREFIX}#`))
		return null;
	const tree = ctx.tree();
	const rel = tree.repoRel(file);
	if (rel === null) return null;
	const lines = addedLines(rel, ctx, tree).filter((l) =>
		l.includes(`${PREFIX}#`),
	);
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
