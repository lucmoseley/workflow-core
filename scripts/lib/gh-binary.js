const { execFileSync } = require("node:child_process");

const { spawnTimeout } = require("./hook-deadline.js");

// measured 53 MB across 14,433 comments, #5355
const MAX_BUFFER = 256e6;

// measured 8-187 s over 114 calls under load, #2677
const GH_TIMEOUT_MS = 300_000;

const ghBinary = () => process.env.WFC_GH || "gh";

/**
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [opts]
 * @returns {string}
 */
function ghUnrouted(args, opts = {}) {
	return /** @type {string} */ (
		execFileSync(ghBinary(), args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: MAX_BUFFER,
			...opts,
			timeout: spawnTimeout(opts.timeout ?? GH_TIMEOUT_MS),
		})
	);
}

module.exports = {
	ghBinary,
	ghUnrouted,
	MAX_BUFFER,
	GH_TIMEOUT_MS,
};
