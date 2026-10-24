/*
 * repo-checks-reading.js — what the daily repo-checks runner and its reader,
 * check-tracker-sweep.js, must spell alike: where the merged result lives,
 * the command that lists a job's findings by hand (workflow-core#1557), and the name its
 * notify reports go by, which delivery and the replay both match (workflow-core#1723).
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { slug } = require("./notify-report");
const { scriptPath } = require("./script-path");

const WHERE = "repo-checks";
const RESULT = ".repo-checks.json";

/**
 * The git common directory, so a worktree reads and writes its main
 * checkout's reading. Throws where `cwd` is not a git checkout.
 * @param {string} cwd
 */
const commonDir = (cwd) =>
	execFileSync(
		"git",
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();

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
	commonDir,
	resultFile,
	buildHandCommand,
	reportName,
	isRepoChecksReport,
};
