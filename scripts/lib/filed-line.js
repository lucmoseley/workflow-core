/**
 * @param {number} n
 * @param {string} url
 */
const buildFiledLine = (n, url) => `Filed #${n}: ${url}`;

const FILED_LINE = /^Filed #(\d+): \S+$/m;

/**
 * @param {string} stdout
 * @returns {{line: string, n: number} | null}
 */
function findFiledLine(stdout) {
	const m = FILED_LINE.exec(stdout);
	return m === null ? null : { line: m[0], n: Number(m[1]) };
}

/**
 * @param {string} stdout
 * @returns {{line: string, n: number}}
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
