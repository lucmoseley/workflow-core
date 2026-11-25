const { execGit } = require("./git.js");
const { buildReleaseLagPort, readLatestTag } = require("./release-tags.js");

const CITED = /(?<![\w./-])#(\d+)\b/g;

/**
 * @param {string} root
 * @returns {{tag: string, cited: Set<number>} | null}
 */
function readShipped(root) {
	try {
		const tag = readLatestTag(root);
		if (!tag) return null;
		const port = buildReleaseLagPort(root);
		const source = port.sourceOf(tag);
		if (!source || !port.hasCommit(source)) return null;
		const subjects = String(
			execGit(["log", "--format=%s", source], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				maxBuffer: 64e6,
			}),
		);
		const cited = new Set(
			[...subjects.matchAll(CITED)].map((m) => Number(m[1])),
		);
		return { tag, cited };
	} catch {
		return null;
	}
}

module.exports = { readShipped };
