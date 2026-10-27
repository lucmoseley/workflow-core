/*
 * tracker-remotes.js — which remotes of a clone name the tracker, and the
 * command that fetches its history into a clone that lacks it. A clone of the
 * public code repo holds none of it (workflow-core#1954).
 */

const { parseGithubRemote } = require("./workflow-core-config.js");
const { spawnGitSync } = require("./git.js");

/**
 * Whether a url names `repo`, owner/name compared as GitHub does, ignoring
 * case.
 * @param {string} url
 * @param {string} repo owner/name
 */
const names = (url, repo) =>
	parseGithubRemote(url)?.toLowerCase() === repo.toLowerCase();

/**
 * The remotes whose url names the tracker.
 * @param {string} tracker owner/name
 * @param {{ cwd?: string }} [opts]
 */
function readTrackerRemotes(tracker, { cwd } = {}) {
	// Exit 1 where no remote has a url at all: no tracker remote either.
	const out = spawnGitSync(["config", "--get-regexp", "^remote\\..*\\.url$"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).stdout;
	return out.split("\n").flatMap((line) => {
		const [key, url] = line.split(/\s+/);
		return key !== undefined && url !== undefined && names(url, tracker)
			? [key.slice("remote.".length, -".url".length)]
			: [];
	});
}

/**
 * @param {string[]} remotes the remotes naming the tracker
 * @param {string} tracker owner/name
 */
const fetchTrackerCommand = (remotes, tracker) =>
	remotes.length === 0
		? `git remote add archive https://github.com/${tracker}.git && git fetch archive`
		: `git fetch ${remotes[0]}`;

module.exports = { names, readTrackerRemotes, fetchTrackerCommand };
