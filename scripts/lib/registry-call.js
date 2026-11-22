const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/**
 * @param {string} program
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {import("./package-vetting.js").Call}
 */
function call(program, args, timeoutMs) {
	const r = spawnSync(program, args, {
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: CHILD_MAX_BUFFER,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const code = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code;
	if (code === "ENOENT") return { missing: true };
	return { status: r.status, stdout: r.stdout ?? "" };
}

const curlBin = () => process.env.WFC_CURL || "curl";

module.exports = { call, curlBin };
