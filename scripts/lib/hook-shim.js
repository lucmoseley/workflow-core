/*
 * hook-shim.js — what marks a husky hook as the core's shim, and the guard
 * registry's row for it (workflow-core#5477). Every adopter's shims are one rendering, so
 * their row lives here, never in an adopter's manifest.
 */

/**
 * The hooks whose refusal would stop git: every hook but these four. pre-push
 * refuses no push on a checker that cannot run (workflow-core#1444), and git ignores
 * post-commit's, post-merge's and a finished post-checkout's exit, so none
 * refuses where no core resolves.
 */
const FAIL_OPEN_HOOKS = new Set([
	"pre-push",
	"post-commit",
	"post-merge",
	"post-checkout",
]);

/** A line every shim carries, which tells it from an adopter's own hook. */
const SHIM_MARK = "# workflow-core hook shim:";

/** @param {string} text */
const isHookShim = (text) =>
	text.split("\n").some((line) => line.startsWith(SHIM_MARK));

/**
 * The guard registry's row for the shim at `.husky/<hook>`.
 * @param {string} hook
 * @returns {Record<string, string>}
 */
function shimAnnotation(hook) {
	const failOpen = FAIL_OPEN_HOOKS.has(hook);
	return {
		IMPLICIT: `on every ${hook}, finds workflow-core through scripts/lib/resolve-core.js and runs that core's .husky/${hook}; ${failOpen ? "where none resolves, says so and lets git go on" : "where none resolves, refuses"}.`,
		JUSTIFIED:
			"fail-safe — a hook naming no plugin path cannot be left pointing at a pruned version or at another machine's install (workflow-core#1839).",
		DEFEAT: `WORKFLOW_CORE_DIR or WORKFLOW_CORE_CHECKOUT chooses the core that runs; the core's .husky/${hook} names its own.`,
	};
}

module.exports = {
	FAIL_OPEN_HOOKS,
	SHIM_MARK,
	isHookShim,
	shimAnnotation,
};
