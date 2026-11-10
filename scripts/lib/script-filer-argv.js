/*
 * script-filer-argv.js — the file-issue.js argv a script builds for a filing
 * no person makes, so a flag file-issue.js gains is added here once rather
 * than at every script filer (#4859). A script filing names its origin in
 * code and declares `--no-fault`: what it files is an incident instance, not
 * a claim to stop a fault (#4796).
 *
 * A CORE: it reads nothing but its arguments.
 */

/**
 * @typedef {{parent: number} | {standalone: string}} Placement
 * @typedef {object} ScriptFiling
 * @property {string} title
 * @property {readonly string[]} labels
 * @property {Placement} placement
 * @property {string} origin one of lib/issue-origin.js's ORIGINS
 * @property {readonly number[]} [distinctFrom] open lookalikes already
 *   ruled out
 * @property {readonly number[]} [sizeLineChecked]
 * @property {string} [bodyFile] `-` (the default) reads the body from stdin
 */

/**
 * @param {ScriptFiling} f
 * @returns {string[]}
 */
function buildScriptFilerArgv({
	title,
	labels,
	placement,
	origin,
	distinctFrom = [],
	sizeLineChecked = [],
	bodyFile = "-",
}) {
	return [
		"--title",
		title,
		...labels.flatMap((l) => ["--label", l]),
		...("parent" in placement
			? ["--parent", String(placement.parent)]
			: ["--standalone", placement.standalone]),
		"--origin",
		origin,
		"--no-fault",
		...listFlag("--distinct-from", distinctFrom),
		...listFlag("--size-line-checked", sizeLineChecked),
		"--body-file",
		bodyFile,
	];
}

/**
 * @param {string} flag
 * @param {readonly number[]} ns
 */
const listFlag = (flag, ns) => (ns.length > 0 ? [flag, ns.join(",")] : []);

module.exports = { buildScriptFilerArgv };
