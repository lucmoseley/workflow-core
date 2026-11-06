/*
 * grouped-child.js — a child in a process group of its own, so a kill reaches
 * what it starts as well (#2677). `execFile`'s timeout kills only the process
 * it spawned, and its `detached` is dropped.
 *
 * A group still live when this process exits is killed with it. RESIDUAL: a
 * SIGKILL to this process cannot be caught, and leaves the group running.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { caught } = require("./caught.js");
const { REAL_PROC } = require("./proc-root.js");
const { FIELD, readStatFields } = require("./proc-stat.js");

/* Untraced: short against a grace, long enough not to spin. */
const GRACE_POLL_MS = 100;
/* A guess, as process-fixture.ts's: the kernel's reaping runs on its own clock. */
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
 * Signal a whole process group. A group already gone is no failure: its
 * close is on its way (#2306).
 * @param {number} pgid
 * @param {NodeJS.Signals} signal
 * @returns {string|null} why the group is still running, else null
 */
function killGroup(pgid, signal) {
	try {
		process.kill(-pgid, signal);
		return null;
	} catch (e) {
		return caught(e).code === "ESRCH" ? null : caught(e).message;
	}
}

/**
 * Whether any member of the group still runs. A zombie is no member: one this
 * process spawned stays a zombie while a synchronous wait keeps it unreaped,
 * yet still answers a signal to its group.
 * @param {number} pgid
 */
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
 * Blocks this thread while it polls, as `claude stop` blocks its caller.
 * @param {number} pgid
 * @param {number} ms
 * @returns {boolean} whether the group went within `ms`
 */
function isGroupGoneWithin(pgid, ms) {
	const pause = new Int32Array(new SharedArrayBuffer(4));
	for (const end = performance.now() + ms; performance.now() < end; ) {
		if (!isGroupAlive(pgid)) return true;
		Atomics.wait(pause, 0, 0, GRACE_POLL_MS);
	}
	return !isGroupAlive(pgid);
}

/**
 * SIGTERM to a group, then SIGKILL to what outlives `graceMs`, returning once
 * the group has gone. Synchronous: it blocks for up to `graceMs` and the
 * kill's settling.
 * @param {number} pgid
 * @param {number} graceMs
 * @returns {{killed: boolean, unkilled: string|null}} `killed` where the
 *   grace ran out; `unkilled` why the group is still running, else null
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
 * Run `file` with `args` in a group of its own, collecting its output. Past
 * `timeoutMs`, or once stdout passes `maxBuffer` bytes, the run ends, naming
 * why in `killedFor` and `killedCode`, and `unkilled` if the group would not
 * take the signal. The group gets SIGKILL and the run settles at once, without
 * waiting on pipes a descendant that left the group may hold open. `stdout` and
 * `stderr` stop at the kill. `spawnCode` names why `file` would not start (ENOENT, EACCES), else
 * null.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs: number,
 *   maxBuffer: number, input?: string}} opts
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null,
 *   stdout: string, stderr: string, killedFor: string|null,
 *   killedCode: "ETIMEDOUT"|"ENOBUFS"|null, unkilled: string|null,
 *   spawnCode: string|null}>}
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
			/* A child that exits with its input unread is no failure of this run
			 * (#3923). */
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
		/* Only stderr's tail is ever read, so past the cap its oldest chunks go. */
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
