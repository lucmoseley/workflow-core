/*
 * wsl-currency.js — the check-wsl-currency core (#4082): judges this machine's
 * WSL version against upstream's latest stable release. Held apart from its
 * reads so each verdict is testable without a bridge or a network.
 */

const { compareVersions } = require("./compare-versions.js");
const { scriptPath } = require("./script-path.js");

/*
 * --jq keeps each answer to the fields judged, so a release's optional fields
 * cannot turn the gh contract red. 100 is GitHub's largest page.
 */
const RELEASE_READS = {
	latest: ["api", "repos/microsoft/WSL/releases/latest", "--jq", "{tag_name}"],
	releases: [
		"api",
		"repos/microsoft/WSL/releases?per_page=100",
		"--jq",
		"[.[] | {tag_name, prerelease, draft}]",
	],
};

/**
 * @typedef {{tag_name: string, prerelease: boolean, draft: boolean}} ReleaseRow
 * @typedef {{why: string}} Failed
 * @typedef {{
 *   readKernelRelease: () => string | Failed,
 *   readInstalled: () => {version: string} | Failed,
 *   readLatest: () => {tag_name?: unknown} | Failed,
 *   readReleases: () => ReleaseRow[] | Failed,
 * }} Ports
 * @typedef {{state: "NOT_WSL" | "UNREAD" | "BEHIND" | "CURRENT", lines: string[]}} Verdict
 */

/**
 * A version's numeric components, or null where it is not one.
 * @param {string} text
 * @returns {number[] | null}
 */
function parseVersion(text) {
	return /^\d+(?:\.\d+)*$/.test(text) ? text.split(".").map(Number) : null;
}

/**
 * Stable tags above `installed`.
 * @param {ReleaseRow[]} rows
 * @param {number[]} installed
 */
function countStableAbove(rows, installed) {
	return rows.filter((r) => {
		const tag = parseVersion(r.tag_name);
		return (
			!r.draft &&
			!r.prerelease &&
			tag !== null &&
			compareVersions(tag, installed) > 0
		);
	}).length;
}

/**
 * @param {string} why
 * @returns {Verdict}
 */
const buildUnread = (why) => ({
	state: "UNREAD",
	lines: [
		`WSL currency not read, so whether this machine is behind is unknown: ${why}.`,
	],
});

/**
 * @param {unknown} answer
 * @returns {answer is Failed}
 */
const isFailed = (answer) =>
	typeof answer === "object" && answer !== null && "why" in answer;

/**
 * @param {Ports} ports
 * @returns {Verdict}
 */
function judgeCurrency(ports) {
	const kernel = ports.readKernelRelease();
	if (isFailed(kernel)) return buildUnread(`the kernel release: ${kernel.why}`);
	if (!/microsoft/i.test(kernel))
		return {
			state: "NOT_WSL",
			lines: ["the kernel release carries no `microsoft`, so this is not WSL."],
		};

	const installed = ports.readInstalled();
	const latest = ports.readLatest();
	const releases = ports.readReleases();
	const latestTag =
		!isFailed(latest) && typeof latest.tag_name === "string"
			? latest.tag_name
			: null;
	const faults = [
		isFailed(installed) && `wsl.exe --version: ${installed.why}`,
		isFailed(latest)
			? `the latest release: ${latest.why}`
			: latestTag === null && "the latest release: gh answered with no tag",
		isFailed(releases)
			? `the release list: ${releases.why}`
			: releases.length === 0 && "the release list: gh answered with none",
	].filter(Boolean);
	if (
		isFailed(installed) ||
		latestTag === null ||
		isFailed(releases) ||
		releases.length === 0
	)
		return buildUnread(faults.join("; "));

	const have = parseVersion(installed.version);
	const newest = parseVersion(latestTag);
	if (have === null || newest === null)
		return buildUnread(
			`versions that will not compare: ${installed.version} against ${latestTag}`,
		);
	if (compareVersions(have, newest) >= 0)
		return {
			state: "CURRENT",
			lines: [
				`WSL ${installed.version} is current: the latest stable release is ${latestTag}.`,
			],
		};
	const behind = countStableAbove(releases, have);
	return {
		state: "BEHIND",
		lines: [
			`WSL ${installed.version} is ${behind} stable ${behind === 1 ? "release" : "releases"} behind ${latestTag}.`,
			"To update, first in WSL:",
			`node ${scriptPath("refill-loop.js")} set --pause`,
			"Then in Windows PowerShell:",
			"wsl --update",
			"The update installs by itself when its download finishes, and installing ends every session, so pick the moment.",
		],
	};
}

module.exports = { RELEASE_READS, judgeCurrency };
