/**
 * The 1-based lines of a shell source where a pipe feeds `grep -q`, the shape
 * `pipefail` turns into a SIGPIPE race (#4983). A pipe ending one line and
 * continued on the next counts; an `||` and comment lines do not.
 *
 * @param {string} src
 * @returns {number[]}
 */
export function findPipedQuietGrep(src) {
	const quietGrep =
		/^\s*grep\b(?:\s+-[^\s-]*)*?\s+(?:-[A-Za-pr-z]*q[A-Za-z]*|--quiet|--silent)\b/;
	const lines = src.split("\n");
	/** @type {number[]} */
	const hits = [];
	let pipeOpen = false;
	lines.forEach((line, i) => {
		if (/^\s*#/.test(line)) {
			pipeOpen = false;
			return;
		}
		const segments = line.split(/(?<!\|)\|(?!\|)/).slice(pipeOpen ? 0 : 1);
		if (segments.some((s) => quietGrep.test(s))) hits.push(i + 1);
		pipeOpen = /(?<!\|)\|\s*$/.test(line);
	});
	return hits;
}
