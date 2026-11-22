const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { childVerdict } = require("./child-failure.js");

// guess, #5529
const CHILD_TIMEOUT_MS = 120 * 1000;

// 91 s a page measured, #5529
const CHROME_TIMEOUT_MS_A_PAGE = 300_000;

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions & {timeout: number}} opts
 */
function spawnRaw(file, args, opts) {
	let r;
	try {
		r = spawnSync(file, args, {
			encoding: "utf8",
			maxBuffer: CHILD_MAX_BUFFER,
			...opts,
		});
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));
		return { status: null, stdout: "", stderr: "", error };
	}
	return {
		status: r.status,
		stdout: String(r.stdout ?? ""),
		stderr: String(r.stderr ?? ""),
		error: r.error,
	};
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions & {timeout: number}} opts
 */
function spawnChild(file, args, opts) {
	const child = spawnRaw(file, args, opts);
	return { ...child, ...childVerdict(child) };
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions} [opts]
 */
const runTickChild = (file, args, opts = {}) =>
	spawnChild(file, args, { timeout: CHILD_TIMEOUT_MS, ...opts });

module.exports = {
	CHILD_TIMEOUT_MS,
	CHROME_TIMEOUT_MS_A_PAGE,
	runTickChild,
	spawnChild,
	spawnRaw,
};
