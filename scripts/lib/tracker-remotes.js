const { parseGithubRemote } = require("./workflow-core-config.js");
const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { shellQuote } = require("./sh-quote.js");

/** @param {string} url @param {string} repo */
const names = (url, repo) =>
	parseGithubRemote(url)?.toLowerCase() === repo.toLowerCase();

/** @param {string} tracker @param {{ cwd?: string }} [opts] */
function readTrackerRemotes(tracker, { cwd } = {}) {
	const r = spawnGitSync(["config", "--get-regexp", "^remote\\..*\\.url$"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	return String(r.stdout)
		.split("\n")
		.flatMap((line) => {
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
