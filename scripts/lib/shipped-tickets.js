const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { execGit } = require("./git.js");
const { REF_FORMS, scanIssueRefs } = require("./issue-ref.js");
const { buildReleaseLagPort, readLatestTag } = require("./release-tags.js");

const TRAILING_CITE = /\(([^()]*)\)[ \t]*$/;

/** @param {string} subject @returns {number[]} */
const citedBy = (subject) =>
	scanIssueRefs(TRAILING_CITE.exec(subject)?.[1] ?? "", REF_FORMS.citation)
		.filter((r) => r.name === null)
		.map((r) => r.number);

/**
 * @param {string} root
 * @returns {null | {tag: string, cited: Set<number>} | {unread: string}}
 */
function readShipped(root) {
	if (!fs.existsSync(path.join(root, ".git"))) return null;
	try {
		const tag = readLatestTag(root);
		if (!tag) return null;
		const port = buildReleaseLagPort(root);
		const source = port.sourceOf(tag);
		if (!source)
			return { unread: `${tag}: its message carries no rendered-from line` };
		if (!port.hasCommit(source))
			return { unread: `${tag}: its source ${source} is not in this clone` };
		const subjects = String(
			execGit(["log", "--format=%s", source], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		).split("\n");
		return { tag, cited: new Set(subjects.flatMap(citedBy)) };
	} catch (e) {
		return { unread: caught(e).message.split("\n")[0] ?? "git failed" };
	}
}

module.exports = { readShipped };
