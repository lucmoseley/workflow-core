const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { withoutLateEpipe } = require("./child-failure.js");
const { spawnGitSync } = require("./git.js");

/** @typedef {import("./check").Ctx} Ctx */

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} [input]
 */
function spawn(cmd, args, input) {
	return withoutLateEpipe(
		spawnSync(cmd, args, {
			input,
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
		}),
	);
}

/** @param {Ctx} ctx @param {string[]} args @returns {string[]} */
function readStagedDiff(ctx, args) {
	const r = spawnGitSync(["diff", "--cached", "-z", ...args], {
		encoding: "utf8",
	});
	if (r.status !== 0) ctx.broken(`git diff --cached failed: ${r.stderr}`);
	return r.stdout.split("\0").filter(Boolean);
}

/** @param {string} spec @returns {string | null} */
function readBlob(spec) {
	const r = spawnGitSync(["cat-file", "blob", spec], { encoding: "utf8" });
	return r.status === 0 ? r.stdout : null;
}

/** @param {Ctx} ctx */
function readRenameSources(ctx) {
	const fields = readStagedDiff(ctx, [
		"--name-status",
		"-M",
		"--diff-filter=R",
	]);
	/** @type {Map<string, string>} */
	const sources = new Map();
	for (let i = 0; ; i += 3) {
		const from = fields[i + 1];
		const to = fields[i + 2];
		if (from === undefined || to === undefined) break;
		sources.set(to, from);
	}
	return sources;
}

module.exports = { readBlob, readRenameSources, spawn, readStagedDiff };
