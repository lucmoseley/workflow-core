const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";

// #3564 measured 7.4 s slowest degraded call, ~10 s vsock stall
const WSL_BUDGET_MS = 12_000;

const TRIES = 3;

/** @param {Buffer} raw */
const decodeWslText = (raw) => raw.toString("latin1").replaceAll("\0", "");

/**
 * @param {string} bin
 * @param {number} budgetMs
 * @returns {{version: string} | {why: string}}
 */
function readInstalled(bin, budgetMs) {
	let answer = readOnce(bin, budgetMs);
	for (let i = 1; i < TRIES && answer.stalled; i++)
		answer = readOnce(bin, budgetMs);
	const { stalled: _, ...result } = answer;
	return result;
}

/**
 * @param {string} bin
 * @param {number} budgetMs
 * @returns {{version: string, stalled?: false} | {why: string, stalled: boolean}}
 */
function readOnce(bin, budgetMs) {
	const r = spawnSync(bin, ["--version"], {
		stdio: ["ignore", "pipe", "pipe"],
		timeout: budgetMs,
		killSignal: "SIGKILL",
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error) {
		const stalled = caught(r.error).code === "ETIMEDOUT";
		return {
			why: stalled ? `no answer within ${budgetMs / 1000} s` : r.error.message,
			stalled,
		};
	}
	if (r.status !== 0) {
		const said = decodeWslText(r.stderr).trim().split(/\r?\n/).pop();
		return {
			stalled: true,
			why: `${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${said ? `: ${said}` : ""}`,
		};
	}
	const version = /\bWSL version:\s*(\d+(?:\.\d+)*)/.exec(
		decodeWslText(r.stdout),
	)?.[1];
	return version === undefined
		? { why: "printed no version line", stalled: false }
		: { version };
}

module.exports = { WSL_BUDGET_MS, WSL_EXE, readInstalled };
