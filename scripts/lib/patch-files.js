/**
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
