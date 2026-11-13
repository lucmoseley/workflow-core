/*
 * body-file.js — the readFile port a guard host hands a core that reads a
 * `gh` call's --body-file (lib/gh-body.js): the file's text, undefined where
 * it is absent; it throws where the file cannot be read. One copy, so every
 * host reads a body file alike (workflow-core#4492).
 */

const { readText } = require("./file-read.js");

/** @param {string} p */
function readBodyFile(p) {
	const got = readText(p);
	if (got.state === "unreadable") throw got.error;
	return got.state === "read" ? got.data : undefined;
}

module.exports = { readBodyFile };
