/*
 * repo-checks-reading.js — what the daily repo-checks runner and its reader,
 * check-tracker-sweep.js, must spell alike: where the merged result lives,
 * the command that lists a job's findings by hand (#1557), and the name its
 * notify reports go by, which delivery and the replay both match (#1723).
 */

const path = require("node:path");

const { slug } = require("./notify-report");
const { scriptPath } = require("./script-path");

const WHERE = "repo-checks";
const RESULT = ".repo-checks.json";

/** @param {string} dir the git common directory */
const resultFile = (dir) => path.join(dir, RESULT);

/** @param {string} repo repo-checks.js's repoKey() */
const reportName = (repo) => `${WHERE}.${repo}`;

/**
 * True where a notify-store key, as lib/notify-report.js lists it, is one
 * `reportName` wrote.
 *
 * @param {string} key
 */
const isRepoChecksReport = (key) => key.startsWith(slug(reportName("")));

/**
 * @param {import("./repo-checks-registry.js").RepoCheck} entry
 * @returns {string}
 */
const buildHandCommand = ({ script, args = [], since }) =>
	["node", scriptPath(script), ...args, ...(since ? ["--all"] : [])].join(" ");

module.exports = {
	WHERE,
	resultFile,
	buildHandCommand,
	reportName,
	isRepoChecksReport,
};
