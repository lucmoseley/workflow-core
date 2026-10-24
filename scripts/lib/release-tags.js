/*
 * release-tags.js — which tag is the last release, as release-plugin.js and
 * check-surface-contract.js must both read it: a major bump and a broken
 * helper surface are judged against the same prior release (#463) — and the
 * release commit's message, which release-plugin.js writes and
 * release-contains.js reads back (#797).
 */

const { execFileSync } = require("node:child_process");
const { cutAt } = require("./cut-at.js");

/** A release tag as release-plugin.js cuts one. */
const TAG_RE = /^v\d+\.\d+\.\d+$/;

/**
 * @param {string} plugin
 * @param {string} tag
 * @param {string} source the 40-hex commit the release was rendered from
 */
const releaseMessage = (plugin, tag, source) =>
	`Release ${plugin} ${tag}, rendered from ${source}`;

/** The source `releaseMessage` names, captured. */
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
function releaseTags(root) {
	return sortedReleaseTags(
		execFileSync("git", ["tag", "--list", "v*"], {
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
const latestTag = (root) => releaseTags(root).at(-1) ?? null;

module.exports = {
	RENDERED_FROM,
	TAG_RE,
	isMajorBump,
	latestTag,
	newestTag,
	releaseMessage,
	releaseTags,
};
