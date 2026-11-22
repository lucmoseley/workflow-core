/**
 * @typedef {{parent: number} | {standalone: string}} Placement
 * @typedef {object} ScriptFiling
 * @property {string} title
 * @property {readonly string[]} labels
 * @property {Placement} placement
 * @property {string} origin
 * @property {readonly number[]} [distinctFrom]
 * @property {readonly number[]} [sizeLineChecked]
 * @property {string} [bodyFile]
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
		...buildListFlag("--distinct-from", distinctFrom),
		...buildListFlag("--size-line-checked", sizeLineChecked),
		"--body-file",
		bodyFile,
	];
}

/**
 * @param {string} flag
 * @param {readonly number[]} ns
 */
const buildListFlag = (flag, ns) => (ns.length > 0 ? [flag, ns.join(",")] : []);

module.exports = { buildScriptFilerArgv };
