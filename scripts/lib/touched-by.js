const { GIT_MAX_BUFFER } = require("./census-digest.js");
const { buildGitCeiling } = require("./git-ceiling.js");

// #2210 measured 0.5s for the census over a commit adding two rule files; ~60x that
const TOUCHED_BY_CEILING_MS = 30_000;

/** @returns {import("./git-ceiling.js").GitCeiling} */
function touchedByCeiling() {
	return buildGitCeiling({
		label: "--touched-by",
		ms: Number(process.env.WFC_TOUCHED_BY_CEILING_MS) || TOUCHED_BY_CEILING_MS,
	});
}

/**
 * @param {string} root
 * @param {string} rev
 * @param {import("./git-ceiling.js").GitCeiling} ceiling
 * @returns {Map<string, string>}
 */
function readTouchedBy(root, rev, ceiling) {
	const fields = String(
		ceiling.git(
			[
				"-C",
				root,
				"diff-tree",
				"--no-commit-id",
				"--name-status",
				"-r",
				"-z",
				"--root",
				rev,
			],
			{
				encoding: "utf8",
				maxBuffer: GIT_MAX_BUFFER,
				stdio: ["ignore", "pipe", "pipe"],
			},
			`git diff-tree ${rev}`,
		),
	).split("\0");
	/** @type {Map<string, string>} */
	const touched = new Map();
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const [status, rel] = [fields[i], fields[i + 1]];
		if (status !== undefined && rel !== undefined) touched.set(rel, status);
	}
	return touched;
}

module.exports = { TOUCHED_BY_CEILING_MS, readTouchedBy, touchedByCeiling };
