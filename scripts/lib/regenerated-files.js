/*
 * regenerated-files.js — the `generated-only` files the queue lander renders
 * afresh on every merge it makes (#4541), each with its generator.
 *
 * A file qualifies where its generator's output is a pure function of the tree
 * it renders, its own bytes left out: the merge then has one right value for
 * it, the output on the merged tree, whatever the two sides' copies say (#4167).
 * An anchor file never qualifies: it records a read someone made (#3127, #4490).
 */

/**
 * @typedef {object} Regenerated
 * @property {string} generator
 * @property {(dir: string) => string} render the file's bytes as the
 *   generator renders them on the index of the worktree `dir`
 */

/** @type {ReadonlyMap<string, Regenerated>} */
const REGENERATED_FILES = new Map([
	[
		"docs/test-read-edges.json",
		{
			generator: "scripts/generate-test-read-edges.js",
			/* Required on use: the extractor is large, and only a merge reaches it. */
			render: (dir) =>
				require("./read-edges-render.js").render(dir, { index: true }).text,
		},
	],
]);

module.exports = { REGENERATED_FILES };
