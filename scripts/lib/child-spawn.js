/*
 * child-spawn.js — run a child to its end, and judge it (lib/child-failure.js).
 * Its own module so a program can take it without the load-time state of
 * lib/refill-tick.js, its other caller (#3814).
 */

const { spawnSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { childVerdict } = require("./child-failure.js");

/**
 * The child's status, output and error as text, with their verdict. Each
 * caller's bound is its own, so `timeout` is required.
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").SpawnSyncOptions & {timeout: number}} opts
 */
function spawnChild(file, args, opts) {
	const r = spawnSync(file, args, {
		encoding: "utf8",
		maxBuffer: CHILD_MAX_BUFFER,
		...opts,
	});
	const child = {
		status: r.status,
		stdout: String(r.stdout ?? ""),
		stderr: String(r.stderr ?? ""),
		error: r.error,
	};
	return { ...child, ...childVerdict(child) };
}

module.exports = { spawnChild };
