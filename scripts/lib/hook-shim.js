const FAIL_OPEN_HOOKS = new Set([
	"pre-push",
	"post-commit",
	"post-merge",
	"post-checkout",
]);

const SHIM_MARK = "# workflow-core hook shim:";

/** @param {string} text */
const isHookShim = (text) =>
	text.split("\n").some((line) => line.startsWith(SHIM_MARK));

/**
 * @param {string} hook
 * @returns {Record<string, string>}
 */
function shimAnnotation(hook) {
	const failOpen = FAIL_OPEN_HOOKS.has(hook);
	return {
		IMPLICIT: `on every ${hook}, finds workflow-core through scripts/lib/resolve-core.js and runs that core's .husky/${hook}; ${failOpen ? "where none resolves, says so and lets git go on" : "where none resolves, refuses"}.`,
		JUSTIFIED:
			"fail-safe — a hook naming no plugin path cannot be left pointing at a pruned version or at another machine's install (#1839).",
		DEFEAT: `WORKFLOW_CORE_DIR or WORKFLOW_CORE_CHECKOUT chooses the core that runs; the core's .husky/${hook} names its own.`,
	};
}

module.exports = {
	FAIL_OPEN_HOOKS,
	SHIM_MARK,
	isHookShim,
	shimAnnotation,
};
