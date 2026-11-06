/*
 * regenerated-files.js — the `generated-only` files the queue lander renders
 * afresh on every merge it makes (#4541), each with its generator.
 *
 * A file qualifies where its generator's output is a pure function of the tree
 * it renders, its own bytes left out: the merge then has one right value for
 * it, the output on the merged tree (#4167). An anchor file never qualifies:
 * it records a read someone made (#3127, #4490).
 */

/**
 * @typedef {object} Regenerated
 * @property {string} generator the script, relative to the plugin root, that
 *   writes the file from the tree its working directory holds: the one the
 *   commit gate checks the file with
 */

/** @type {ReadonlyMap<string, Regenerated>} */
const REGENERATED_FILES = new Map([
	[
		"docs/test-read-edges.json",
		{ generator: "scripts/generate-test-read-edges.js" },
	],
]);

module.exports = { REGENERATED_FILES };
