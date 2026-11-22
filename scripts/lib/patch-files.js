/*
 * patch-files.js — the files a patch touches, read from `git apply --numstat
 * -z` output (workflow-core#2740): the one parse commit-paths.js and write-review-marker.js
 * both take. Each caller runs git itself, as each fails in its own terms.
 */

/**
 * One `<added>\t<deleted>\t<path>` field per file. Under `-z` git leaves the
 * path unquoted, so it is everything after the second tab, tabs included.
 * @param {string} stdout
 * @returns {string[]}
 */
function numstatPaths(stdout) {
	return stdout
		.split("\0")
		.filter(Boolean)
		.map((f) => {
			const file = /^[^\t]*\t[^\t]*\t(.+)$/s.exec(f)?.[1];
			if (file === undefined)
				throw new Error(`git apply --numstat gave a field with no path: ${f}`);
			return file;
		});
}

module.exports = { numstatPaths };
