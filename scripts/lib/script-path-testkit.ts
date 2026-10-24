/*
 * script-path-testkit.ts — what a guard or lib message line looks like when it
 * names a core script by a bare path (#343), shared by the scan over the real
 * scripts and the unit cases that pin each shape (#1900).
 */

const SCRIPT_PATH_PATTERN = String.raw`(?:\.\/)?scripts\/[\w./-]+\.(?:js|sh|py)`;

/* A runner's prefix needs nothing after the path: in a JS template literal
 * the line's own backtick would otherwise read as markdown (#1110). */
export const COMMAND_SHAPED = new RegExp(
	String.raw`(?:\b(?:node|bash|sh|source|python3?)\s+|\$\()${SCRIPT_PATH_PATTERN}|\`${SCRIPT_PATH_PATTERN}\s[^\`]`,
);

/* #1110: the path alone, followed by an argument. */
export const PLAIN_POINTER = new RegExp(
	String.raw`(?<![\w./$}-])${SCRIPT_PATH_PATTERN}\s+[\w<[-]`,
);
