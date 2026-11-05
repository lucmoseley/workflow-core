/*
 * regenerated-files.js — the `generated-only` files a lander revert settles by
 * regenerating (#4452), each with its generator. lib/clean-revert.js and the
 * lander read them from here alone.
 *
 * A file qualifies where its generator's output is a pure function of the tree
 * it renders, its own bytes left out: the revert then has one right value for
 * it, the output on the revert's tree. An anchor file never qualifies: it
 * records a read someone made (#3127, #3935).
 */

/**
 * @typedef {object} Regenerated
 * @property {string} generator the script that writes the file
 * @property {(cwd: string, tree: string) => string} renderAt the file's bytes
 *   as the generator renders them on the commit or tree `tree`
 */

/** @type {ReadonlyMap<string, Regenerated>} */
const REGENERATED_FILES = new Map([
	[
		"docs/test-read-edges.json",
		{
			generator: "scripts/generate-test-read-edges.js",
			/* Required on use: the extractor is large, and the gates loading this
			 * list reach it only on a revert's conflict. */
			renderAt: (cwd, tree) =>
				require("./read-edges-render.js").render(cwd, { at: tree }).text,
		},
	],
]);

module.exports = { REGENERATED_FILES };
