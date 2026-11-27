const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { caught } = require("./caught.js");
const { REAL_PROC } = require("./proc-root.js");
const { FIELD, readStatFields } = require("./proc-stat.js");
const { sleepSync } = require("./sleep-sync.js");

// guess, workflow-core#3923
const GRACE_POLL_MS = 100;
// guess, workflow-core#3923
const KILL_SETTLE_MS = 5000;
const NULL_END_FIELDS = {
	code: null,
	signal: null,
	killedFor: null,
	killedCode: null,
	unkilled: null,
	spawnCode: null,
};

/** @type {Set<number>} */
const live = new Set();
process.on("exit", () => {
	for (const pgid of live) killGroup(pgid, "SIGKILL");
});

/**
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 * @returns {string|null}
 */
function killGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
		return null;
	} catch (e) {
		return caught(e).code === "ESRCH" ? null : caught(e).message;
	}
}

/** @param {number} pgid */
function isGroupAlive(pgid) {
	try {
		process.kill(-pgid, 0);
	} catch (e) {
		if (caught(e).code !== "EPERM") return false;
	}
	return fs.readdirSync(REAL_PROC).some((pid) => {
		if (!/^\d+$/.test(pid)) return false;
		const fields = readStatFields(pid, REAL_PROC);
		return (
			Number(fields?.[FIELD.pgrp]) === pgid &&
			!["Z", "X"].includes(String(fields?.[FIELD.state]))
		);
	});
}

/**
 * @param {number} pgid
 * @param {number} ms
 * @returns {boolean}
 */
function isGroupGoneWithin(pgid, ms) {
	for (const end = performance.now() + ms; performance.now() < end; ) {
		if (!isGroupAlive(pgid)) return true;
		sleepSync(GRACE_POLL_MS);
	}
	return !isGroupAlive(pgid);
}

/**
 * @param {number} pgid
 * @param {number} graceMs
 * @returns {{killed: boolean, unkilled: string|null}}
 */
function endGroup(pgid, graceMs) {
	const unsignalled = killGroup(pgid, "SIGTERM");
	if (unsignalled) return { killed: false, unkilled: unsignalled };
	if (isGroupGoneWithin(pgid, graceMs))
		return { killed: false, unkilled: null };
	const unkilled = killGroup(pgid, "SIGKILL");
	if (unkilled) return { killed: true, unkilled };
	return {
		killed: true,
		unkilled: isGroupGoneWithin(pgid, KILL_SETTLE_MS)
			? null
			: `it still answers ${KILL_SETTLE_MS / 1000} s after SIGKILL`,
	};
}

/**
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number, input?: string}} opts
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null, stdout: string, stderr: string, killedFor: string|null, killedCode: "ETIMEDOUT"|"ENOBUFS"|null, unkilled: string|null, spawnCode: string|null}>}
 */
function runGrouped(file, args, { cwd, env, timeoutMs, maxBuffer, input }) {
	const child = spawn(file, args, {
		cwd,
		env,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		detached: true,
	});
	if (child.stdin) {
		child.stdin.on("error", (e) => {
			if (caught(e).code !== "EPIPE") throw e;
		});
		child.stdin.end(input);
	}
	const pgid = /** @type {number} */ (child.pid);
	const stdout = /** @type {import("node:stream").Readable} */ (child.stdout);
	const stderr = /** @type {import("node:stream").Readable} */ (child.stderr);
	if (child.pid) live.add(pgid);
	/** @type {Buffer[]} */
	const out = [];
	let outBytes = 0;
	/** @type {Buffer[]} */
	const err = [];
	let errBytes = 0;
	return new Promise((resolve) => {
		let settled = false;
		let killing = false;
		const settle = (
			/** @type {Omit<Awaited<ReturnType<typeof runGrouped>>, "stdout" | "stderr">} */ r,
		) => {
			if (settled) return;
			settled = true;
			clearTimeout(ceiling);
			resolve({
				...r,
				stdout: Buffer.concat(out).toString("utf8"),
				stderr: Buffer.concat(err).toString("utf8"),
			});
		};
		const kill = (
			/** @type {string} */ why,
			/** @type {"ETIMEDOUT"|"ENOBUFS"} */ killedCode,
		) => {
			if (killing) return;
			killing = true;
			clearTimeout(ceiling);
			const unkilled = killGroup(pgid, "SIGKILL");
			stdout.destroy();
			stderr.destroy();
			settle({
				...NULL_END_FIELDS,
				killedFor: unkilled ? `${why}, unkilled: ${unkilled}` : why,
				killedCode,
				unkilled,
			});
		};
		stdout.on("data", (/** @type {Buffer} */ chunk) => {
			if (killing) return;
			out.push(chunk);
			outBytes += chunk.length;
			if (outBytes > maxBuffer)
				kill(`stdout past ${maxBuffer} bytes`, "ENOBUFS");
		});
		stderr.on("data", (/** @type {Buffer} */ chunk) => {
			if (killing) return;
			err.push(chunk);
			errBytes += chunk.length;
			while (errBytes > maxBuffer && err.length > 1)
				errBytes -= /** @type {Buffer} */ (err.shift()).length;
		});
		const ceiling = setTimeout(
			() => kill(`timed out after ${timeoutMs / 1000} s`, "ETIMEDOUT"),
			timeoutMs,
		);
		child.on("error", (e) => {
			live.delete(pgid);
			settle({
				...NULL_END_FIELDS,
				killedFor: e.message,
				spawnCode: caught(e).code ?? null,
			});
		});
		child.on("close", (code, signal) => {
			live.delete(pgid);
			if (killing) return;
			settle({ ...NULL_END_FIELDS, code, signal });
		});
	});
}

module.exports = { endGroup, isGroupAlive, killGroup, runGrouped };
