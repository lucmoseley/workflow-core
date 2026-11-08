/*
 * The two main-checkout prefixes a core hook command spells (#4701), typed
 * out for fixtures: lib/core-hooks.js keeps them private, and
 * scripts/hook-code-root.test.ts holds these to the registered lines.
 */

// biome-ignore lint/suspicious/noTemplateCurlyInString: the plugin-root variable Claude Code substitutes, not a JS template
export const MAIN_SCRIPTS = '"${CLAUDE_PLUGIN_ROOT}"/../scripts/';
export const CANARY_MAIN_SCRIPTS =
	'"$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir)"/../scripts/';
