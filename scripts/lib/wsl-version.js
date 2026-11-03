/*
 * wsl-version.js — reads this machine's installed WSL version off
 * `wsl.exe --version` (#4082).
 */

const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";

/**
 * lib/interop-probe.sh's per-attempt budget, above the ~10 s vsock stall and
 * the slowest degraded call, 7.4 s (#3564): a wedged bridge must not hold the
 * status fan-out.
 */
const WSL_BUDGET_MS = 12_000;

/**
 * wsl.exe prints UTF-16LE, or UTF-8 under WSL_UTF8; dropping the NULs reads both.
 * @param {Buffer} raw
 */
const readableText = (raw) => raw.toString("latin1").replaceAll("\0", "");

/**
 * @param {string} bin
 * @param {number} budgetMs
 * @returns {{version: string} | {why: string}}
 */
function readInstalled(bin, budgetMs) {
	const r = spawnSync(bin, ["--version"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: budgetMs,
		killSignal: "SIGKILL",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error)
		return {
			why:
				caught(r.error).code === "ETIMEDOUT"
					? `no answer within ${budgetMs / 1000} s`
					: r.error.message,
		};
	if (r.status !== 0) {
		const said = readableText(r.stderr).trim().split(/\r?\n/).pop();
		return {
			why: `${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${said ? `: ${said}` : ""}`,
		};
	}
	const version = /\bWSL version:\s*(\d+(?:\.\d+)*)/.exec(
		readableText(r.stdout),
	)?.[1];
	return version === undefined
		? { why: "printed no version line" }
		: { version };
}

module.exports = { WSL_BUDGET_MS, WSL_EXE, readInstalled };
