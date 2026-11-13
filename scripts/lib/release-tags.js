/*
 * release-tags.js — which tag is the last release, as release-plugin.js and
 * check-surface-contract.js must both read it: a major bump and a broken
 * helper surface are judged against the same prior release (#463) — and the
 * release commit's message, which release-plugin.js writes and
 * release-contains.js reads back (#797).
 */

const { cutAt } = require("./cut-at.js");
const { commitSha } = require("./commit-sha.js");
const { execGit, spawnGitSync } = require("./git.js");

/** A release tag as release-plugin.js cuts one. */
const TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * @param {string} plugin
 * @param {string} tag
 * @param {string} source the 40-hex commit the release was rendered from
 */
const buildReleaseMessage = (plugin, tag, source) =>
	`Release ${plugin} ${tag}, rendered from ${source}`;

/** The source `buildReleaseMessage` names, captured. */
const RENDERED_FROM = /\brendered from ([0-9a-f]{40})\b/;

/** @param {string} tag `v1.2.3` or `1.2.3` */
const majorOf = (tag) =>
	Number.parseInt(cutAt(tag.replace(/^v/, ""), ".")[0], 10);

/**
 * @param {string} tag the version being cut
 * @param {string|null} prior the last release, null before the first
 */
const isMajorBump = (tag, prior) =>
	prior !== null && majorOf(tag) > majorOf(prior);

/**
 * `tags` of the release shape, oldest first; anything else is dropped.
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
 * The highest release tag among `tags`.
 * @param {string[]} tags
 * @returns {string|null}
 */
const newestTag = (tags) => sortedReleaseTags(tags).at(-1) ?? null;

/**
 * Every existing release tag, oldest first.
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
 * The highest existing release tag.
 * @param {string} root
 * @returns {string|null}
 */
const readLatestTag = (root) => readReleaseTags(root).at(-1) ?? null;

/**
 * Whether release `tag` carries `sha`: `sha` is an ancestor of the source its
 * message names. `git tag --contains` cannot answer it, as each release is a
 * root commit (release-contains.js).
 * @param {string} root a clone holding the tags and their sources
 * @param {string} tag
 * @param {string} sha
 * @returns {{carries: boolean} | {unread: string}} `unread` why it cannot say
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

module.exports = {
	RENDERED_FROM,
	readTagCarry,
	TAG_RE,
	isMajorBump,
	readLatestTag,
	newestTag,
	buildReleaseMessage,
	readReleaseTags,
};
