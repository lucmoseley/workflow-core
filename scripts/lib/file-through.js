const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { readDistinctFromHint } = require("./similar-titles.js");

/**
 * @param {string[]} args
 * @param {string} body
 * @param {string} root
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
				env: buildCheckoutEnv(root),
			},
		);
	const filed = spawnFiler(args);
	const hint =
		filed.status === 2 ? readDistinctFromHint(filed.stderr || "") : null;
	return hint ? spawnFiler([...args, "--distinct-from", hint]) : filed;
}

module.exports = { fileThrough };
