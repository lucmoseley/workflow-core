const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { scriptPath } = require("./script-path.js");
const { writeFd } = require("./write-fd.js");

const CANONICAL = ".claude";

/**
 * @param {string} home
 * @returns {string[]}
 */
function readSiblings(home) {
	return fs
		.readdirSync(home, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^\.claude\d+$/.test(d.name))
		.map((d) => path.join(home, d.name))
		.sort();
}

/**
 * @param {string} home
 * @returns {string[]}
 */
function readPlanDirs(home) {
	return [path.join(home, CANONICAL), ...readSiblings(home)];
}

module.exports = { CANONICAL, readPlanDirs, readSiblings };

if (require.main === module) {
	const [home] = process.argv.slice(2);
	if (home === undefined) {
		writeFd(2, `usage: node ${scriptPath("lib/plan-dirs.js")} <home>\n`);
		process.exit(2);
	}
	try {
		writeFd(
			1,
			readPlanDirs(home)
				.map((d) => `${d}\0`)
				.join(""),
		);
	} catch (err) {
		writeFd(2, `plan-dirs: ${caught(err).message}\n`);
		process.exit(2);
	}
}
