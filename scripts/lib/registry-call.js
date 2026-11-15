/*
 * registry-call.js — one registry call for the install cores' hosts,
 * lib/npm-install-host.js and lib/pip-install-host.js (#5232): the program
 * run with stdout piped and stderr dropped, and a program that will not
 * start told apart from one that answered.
 *
 * THE SEAM. WFC_CURL names curl (#2266, #2422); unset, curl is PATH's.
 */

const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/**
 * `missing` where the program could not be started, else its status (null
 * where the timeout killed it) and stdout.
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

/** The curl the hosts run. */
const curlBin = () => process.env.WFC_CURL || "curl";

module.exports = { call, curlBin };
