/*
 * wsl-version.js — reads this machine's installed WSL version off
 * `wsl.exe --version` (workflow-core#4082): the adapter, so the core never touches the bridge.
 *
 * THREE TRIES, each at the flat budget, as lib/interop-probe.sh's: a vsock stall
 * fails one call, `accept4 failed 110`, and the next is normal
 * (docs/environment.md §9), which must not read as an unread machine. A binary
 * that will not start is no stall, so it is not retried.
 */

const { spawnSync } = require("node:child_process");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

const WSL_EXE = "/mnt/c/Windows/System32/wsl.exe";

/**
 * lib/interop-probe.sh's per-attempt budget, above the ~10 s vsock stall and
 * the slowest degraded call, 7.4 s (workflow-core#3564): a wedged bridge must not hold the
 * status fan-out.
 */
const WSL_BUDGET_MS = 12_000;

const TRIES = 3;

/**
 * wsl.exe prints UTF-16LE, or UTF-8 under WSL_UTF8; dropping the NULs reads both.
 * @param {Buffer} raw
 */
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
