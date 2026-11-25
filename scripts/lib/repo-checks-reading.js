const path = require("node:path");

const { slug } = require("./notify-report");
const { scriptPath } = require("./script-path");

const WHERE = "repo-checks";
const RESULT = ".repo-checks.json";

/** @param {string} dir */
const resultFile = (dir) => path.join(dir, RESULT);

/** @param {string} repo */
const reportName = (repo) => `${WHERE}.${repo}`;

/** @param {string} key */
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
