const { parseGithubRemote } = require("./workflow-core-config.js");
const { spawnGitSync } = require("./git.js");
const { shellQuote } = require("./sh-quote.js");

/** @param {string} url @param {string} repo */
const names = (url, repo) =>
	parseGithubRemote(url)?.toLowerCase() === repo.toLowerCase();

/** @param {string} tracker @param {{ cwd?: string }} [opts] */
function readTrackerRemotes(tracker, { cwd } = {}) {
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

/** @param {string[]} remotes @param {string} tracker */
const fetchTrackerCommand = ([remote], tracker) =>
	remote === undefined
		? `git remote add archive ${shellQuote(`https://github.com/${tracker}.git`)} && git fetch archive`
		: `git fetch ${shellQuote(remote)}`;

module.exports = { names, readTrackerRemotes, fetchTrackerCommand };
