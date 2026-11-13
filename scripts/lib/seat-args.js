/*
 * seat-args.js — which seats a measuring script reads: every non-empty
 * `--config-dir` `lib/cli-args.js` gathered under its `list` flag, else every
 * config dir `arbiter-store.js` knows. One default for the two instruments the
 * capped launch is sized from (workflow-core#380, workflow-core#1391).
 */

const { configDirs } = require("./arbiter-store");

/**
 * @param {string[] | undefined} given  the parsed `lists["--config-dir"]`
 * @returns {string[]}
 */
function seatsFrom(given) {
	const seats = given?.filter(Boolean) ?? [];
	return seats.length > 0 ? seats : configDirs();
}

module.exports = { seatsFrom };
