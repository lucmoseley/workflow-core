/*
 * file-through.js — file-issue.js run by a script that has already ruled out
 * the duplicate its similar-title check exists to catch: refused for open
 * lookalike titles, it re-runs naming them `--distinct-from`. Callers: the
 * morning review, its reversals, and the memory kill tickets, each finding
 * its own duplicate by exact title first.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { checkoutEnv } = require("./refill-repos.js");
const { readDistinctFromHint } = require("./similar-titles.js");

/**
 * @param {string[]} args file-issue.js's
 * @param {string} body
 * @param {string} root the checkout it files from
 */
function fileThrough(args, body, root) {
	const spawnFiler = (/** @type {string[]} */ a) =>
		spawnSync(
			process.execPath,
			[path.join(__dirname, "..", "file-issue.js"), ...a],
			{
				input: body,
				encoding: "utf8",
				maxBuffer: CHILD_MAX_BUFFER,
				cwd: root,
				env: checkoutEnv(root),
			},
		);
	const filed = spawnFiler(args);
	const hint =
		filed.status === 2 ? readDistinctFromHint(filed.stderr || "") : null;
	return hint ? spawnFiler([...args, "--distinct-from", hint]) : filed;
}

module.exports = { fileThrough };
