export const MAIN_SCRIPTS = `"\${CLAUDE_PLUGIN_ROOT}"/../scripts/`;
export const CANARY_MAIN_SCRIPTS =
	'"$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir)"/../scripts/';
