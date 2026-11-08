/*
 * filed-line.js — the line file-issue.js prints naming the issue it filed,
 * and its reading by a caller that ran file-issue.js. The rest of what
 * file-issue.js prints names other issues — the similar titles and the
 * size-line siblings it checked — so the first `#<n>` of its output may be
 * any of them (#4485).
 *
 * A CORE: it reads nothing but its arguments.
 */

/**
 * @param {number} n
 * @param {string} url
 */
const buildFiledLine = (n, url) => `Filed #${n}: ${url}`;

const FILED_LINE = /^Filed #(\d+): \S+$/m;

/**
 * The filed-issue line of what file-issue.js printed, and its number.
 * @param {string} stdout
 * @returns {{line: string, n: number} | null} null where it printed none
 */
function findFiledLine(stdout) {
	const m = FILED_LINE.exec(stdout);
	return m === null ? null : { line: m[0], n: Number(m[1]) };
}

/**
 * {@link findFiledLine}, for a caller that cannot go on without the number.
 * @param {string} stdout
 * @returns {{line: string, n: number}}
 * @throws {Error} where it printed none
 */
function parseFiledLine(stdout) {
	const filed = findFiledLine(stdout);
	if (filed === null)
		throw new Error(
			`file-issue exited 0 but printed no Filed #<n> line: ${stdout.trim().split("\n")[0] ?? ""}`,
		);
	return filed;
}

module.exports = { buildFiledLine, findFiledLine, parseFiledLine };
