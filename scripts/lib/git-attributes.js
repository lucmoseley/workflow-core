const { spawnGitSync } = require("./git.js");

const EXCLUDING_ATTRS = ["linguist-vendored", "linguist-generated"];

/**
 * @typedef {{ cached?: boolean, source?: string, timeout?: number, cwd?: string }} AttributeRead
 */

/**
 * @param {string[]} paths
 * @param {AttributeRead} [read]
 * @returns {Set<string>}
 */
function readAttributeExcluded(paths, { cached, source, timeout, cwd } = {}) {
	if (paths.length === 0) return new Set();
	const r = spawnGitSync(
		[
			"check-attr",
			"-z",
			"--stdin",
			...(cached ? ["--cached"] : []),
			...(source === undefined ? [] : [`--source=${source}`]),
			...EXCLUDING_ATTRS,
		],
		{
			input: paths.map((p) => `${p}\0`).join(""),
			encoding: "utf8",
			...(timeout === undefined ? {} : { timeout }),
			...(cwd === undefined ? {} : { cwd }),
		},
	);
	if (r.status !== 0)
		throw new Error(`git check-attr failed: ${r.stderr.trim()}`);
	const fields = r.stdout.split("\0");
	const excluded = new Set();
	for (let i = 0; i + 2 < fields.length; i += 3) {
		const value = fields[i + 2];
		if (value === "set" || value === "true") excluded.add(fields[i]);
	}
	return excluded;
}

module.exports = { readAttributeExcluded };
