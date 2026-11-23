const { cutAt } = require("./cut-at.js");
const { commitSha, readCommitOrBroken } = require("./commit-sha.js");
const { execGit, spawnGitSync } = require("./git.js");

const TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * @param {string} plugin
 * @param {string} tag
 * @param {string} source
 */
const buildReleaseMessage = (plugin, tag, source) =>
	`Release ${plugin} ${tag}, rendered from ${source}`;

const RENDERED_FROM = /\brendered from ([0-9a-f]{40})\b/;

/** @param {string} tag */
const majorOf = (tag) =>
	Number.parseInt(cutAt(tag.replace(/^v/, ""), ".")[0], 10);

/**
 * @param {string} tag
 * @param {string|null} prior
 */
const isMajorBump = (tag, prior) =>
	prior !== null && majorOf(tag) > majorOf(prior);

/**
 * @param {string[]} tags
 * @returns {string[]}
 */
const sortedReleaseTags = (tags) =>
	tags
		.filter((t) => TAG_RE.test(t))
		.sort(
			(a, b) =>
				majorOf(a) - majorOf(b) ||
				a.localeCompare(b, undefined, { numeric: true }),
		);

/**
 * @param {string[]} tags
 * @returns {string|null}
 */
const newestTag = (tags) => sortedReleaseTags(tags).at(-1) ?? null;

/**
 * @param {string} root
 * @returns {string[]}
 */
function readReleaseTags(root) {
	return sortedReleaseTags(
		execGit(["tag", "--list", "v*"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		})
			.trim()
			.split("\n"),
	);
}

/**
 * @param {string} root
 * @returns {string|null}
 */
const readLatestTag = (root) => readReleaseTags(root).at(-1) ?? null;

/**
 * @param {string} root
 * @param {string} tag
 * @param {string} sha
 * @returns {{carries: boolean} | {unread: string}}
 */
function readTagCarry(root, tag, sha) {
	const message = execGit(["log", "-1", "--format=%B", tag], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const source = RENDERED_FROM.exec(String(message))?.[1];
	if (!source)
		return { unread: `${tag}: its message carries no rendered-from line` };
	if (commitSha(root, source) === null)
		return { unread: `${tag}: its source ${source} is not in this clone` };
	const r = spawnGitSync(["merge-base", "--is-ancestor", sha, source], {
		cwd: root,
		stdio: "ignore",
	});
	if (r.status === 0 || r.status === 1) return { carries: r.status === 0 };
	throw new Error(`git merge-base failed on ${tag}'s source ${source}`);
}

/** @param {string} root @param {string[]} args */
const gitOut = (root, args) =>
	String(
		execGit(args, {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}),
	).trim();

/**
 * @param {string} root
 * @param {string} tag
 * @returns {number}
 */
const readCutTime = (root, tag) =>
	Number(
		gitOut(root, [
			"for-each-ref",
			"--format=%(creatordate:unix)",
			`refs/tags/${tag}`,
		]),
	);

/**
 * @param {string} root
 * @returns {import("./release-lag").GitPort}
 */
const buildReleaseLagPort = (root) => ({
	sourceOf: (tag) =>
		RENDERED_FROM.exec(gitOut(root, ["log", "-1", "--format=%B", tag]))?.[1] ??
		null,
	hasCommit: (sha) => readCommitOrBroken(sha, root) !== null,
	count: (range) => Number(gitOut(root, ["rev-list", "--count", range])),
	time: (rev) => Number(gitOut(root, ["log", "-1", "--format=%ct", rev])),
});

module.exports = {
	readTagCarry,
	TAG_RE,
	isMajorBump,
	readLatestTag,
	newestTag,
	buildReleaseMessage,
	readReleaseTags,
	readCutTime,
	buildReleaseLagPort,
};
