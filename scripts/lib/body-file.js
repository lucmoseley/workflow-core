/*
 * body-file.js — the readFile port a guard host hands a core that reads a
 * `gh` call's --body-file (lib/gh-body.js): the file's text, undefined where
 * it is absent; it throws where the file cannot be read.
 */

const fs = require("node:fs");

/** @param {string} p */
const readBodyFile = (p) =>
	fs.existsSync(p) ? fs.readFileSync(p, "utf8") : undefined;

module.exports = { readBodyFile };
