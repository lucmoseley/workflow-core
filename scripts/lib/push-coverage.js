/*
 * push-coverage.js — which tests a queue push's own work touches that no
 * local pass covers (#5016): the touched set a bare `npm run test` selects
 * (lib/touched-tests.js), less each file the per-file pass store holds a
 * pass for on the tree's present inputs (lib/pass-store.js's `lookup`, the
 * judge that same run skips a file by). Such a file's first run is the
 * lander's, and a red there costs a whole lander run and a drop.
 *
 * It warns and never refuses: the lander runs the full suite whatever this
 * says. Vitest's route alone, as the pass store records no pytest run.
 */

const { caught } = require("./caught.js");
const { lookup } = require("./pass-store.js");
const { repoRoot } = require("./test-pass-marker.js");
const { selectTouched } = require("./touched-tests.js");

/**
 * @typedef {{ files: string[], touched: number, notice: string|null }
 *   | { why: string }} Coverage `files` the touched tests no pass covers, of
 *   `touched`; `notice` the pass store's own, where it read with a fault
 */

/**
 * @param {string} dir the session worktree, its HEAD the sha to be pushed
 * @param {{ select?: (dir: string) => { files: string[] },
 *   look?: typeof lookup, storeRoot?: string|null }} [seams]
 * @returns {Coverage}
 */
function readUncovered(
	dir,
	{
		select = selectTouched,
		look = lookup,
		storeRoot = repoRoot(dir) || null,
	} = {},
) {
	let files;
	try {
		({ files } = select(dir));
	} catch (err) {
		/* Fails open: the land goes ahead, the warning saying why (#5016). */
		return { why: caught(err).message.trim() };
	}
	if (files.length === 0) return { files: [], touched: 0, notice: null };
	const found = look(files, { root: dir, storeRoot });
	if (found.refused.length > 0)
		return {
			why: `${found.refused.join(", ")} carr${found.refused.length === 1 ? "ies" : "y"} an \`uncached:\` pragma naming no reason, which \`npm run test\` refuses`,
		};
	return { files: found.run, touched: files.length, notice: found.notice };
}

/**
 * The warning `session-checkout.js land` prints for `c`, or null where every
 * touched test is covered.
 * @param {Coverage} c
 * @returns {string|null}
 */
function buildCoverageWarning(c) {
	if ("why" in c)
		return `warning: which touched tests a local pass covers could not be read (${c.why}), so any of them may first run in the lander (#5016)`;
	if (c.files.length === 0) return null;
	return [
		`warning: no local pass covers ${c.files.length} of the ${c.touched} test file${c.touched === 1 ? "" : "s"} your work touches, so the lander runs ${c.files.length === 1 ? "it" : "them"} first, and a red there costs a lander run and a drop (#5016):`,
		...c.files.map((f) => `  ${f}`),
		...(c.notice ? [c.notice] : []),
		"Run them with `npm run test`, which selects them and skips what a pass covers. The push stands: the lander still runs the full suite.",
	].join("\n");
}

module.exports = { buildCoverageWarning, readUncovered };
