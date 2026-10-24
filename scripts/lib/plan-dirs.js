/*
 * plan-dirs.js — the one definition of which config dirs are plan seats:
 * `~/.claude` and each `~/.claude<digits>`. A dir by any other name is no
 * plan (#2528).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

/** The plan whose config every other plan links to. */
const CANONICAL = ".claude";

/**
 * Every plan dir but `~/.claude`, sorted. `readdirSync` follows a symlinked
 * `home` itself; a sibling that is itself a symlink is not a plan dir.
 * @param {string} home
 * @returns {string[]}
 */
function siblings(home) {
	return fs
		.readdirSync(home, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^\.claude\d+$/.test(d.name))
		.map((d) => path.join(home, d.name))
		.sort();
}

/**
 * `~/.claude` first, whether or not it exists, then its siblings.
 * @param {string} home
 * @returns {string[]}
 */
function planDirs(home) {
	return [path.join(home, CANONICAL), ...siblings(home)];
}

module.exports = { CANONICAL, planDirs, siblings };

/*
 * CLI mode.
 *
 *   <home>    prints each plan dir under <home>, NUL-terminated; 2 where
 *             <home> cannot be read
 */
if (require.main === module) {
	const [home] = process.argv.slice(2);
	if (home === undefined) {
		writeFd(2, `usage: node ${scriptPath("lib/plan-dirs.js")} <home>\n`);
		process.exit(2);
	}
	try {
		writeFd(
			1,
			planDirs(home)
				.map((d) => `${d}\0`)
				.join(""),
		);
	} catch (err) {
		writeFd(2, `plan-dirs: ${caught(err).message}\n`);
		process.exit(2);
	}
}
