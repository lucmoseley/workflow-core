/*
 * grouped-child.js — an async child in a process group of its own, so a kill
 * reaches what it starts as well (#2677). `execFile`'s timeout kills only the
 * process it spawned, and its `detached` is dropped.
 *
 * A group still live when this process exits is killed with it. RESIDUAL: a
 * SIGKILL to this process cannot be caught, and leaves the group running.
 */

const { spawn } = require("node:child_process");
const { caught } = require("./caught.js");

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
 * Run `file` with `args` in a group of its own, collecting its output. Past
 * `timeoutMs`, or once stdout passes `maxBuffer` bytes, the group gets SIGKILL
 * and the run settles at once with `killedFor`, without waiting on pipes a
 * descendant that left the group may hold open. `spawnCode` names why `file`
 * would not start (ENOENT, EACCES), else null.
 * @param {string} file
 * @param {string[]} args
 * @param {{cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, maxBuffer: number}} opts
 * @returns {Promise<{code: number|null, signal: NodeJS.Signals|null,
 *   stdout: string, stderr: string, killedFor: string|null,
 *   spawnCode: string|null}>}
 */
function runGrouped(file, args, { cwd, env, timeoutMs, maxBuffer }) {
	const child = spawn(file, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const pgid = /** @type {number} */ (child.pid);
	if (child.pid) live.add(pgid);
	/** @type {Buffer[]} */
	const out = [];
	let outBytes = 0;
	/** @type {Buffer[]} */
	const err = [];
	let errBytes = 0;
	return new Promise((resolve) => {
		let settled = false;
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
		const kill = (/** @type {string} */ why) => {
			const failed = killGroup(pgid, "SIGKILL");
			child.stdout.destroy();
			child.stderr.destroy();
			settle({
				code: null,
				signal: null,
				killedFor: failed ? `${why}, unkilled: ${failed}` : why,
				spawnCode: null,
			});
		};
		child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
			out.push(chunk);
			outBytes += chunk.length;
			if (outBytes > maxBuffer) kill(`stdout past ${maxBuffer} bytes`);
		});
		/* Only stderr's tail is ever read, so past the cap its oldest chunks go. */
		child.stderr.on("data", (/** @type {Buffer} */ chunk) => {
			err.push(chunk);
			errBytes += chunk.length;
			while (errBytes > maxBuffer && err.length > 1)
				errBytes -= /** @type {Buffer} */ (err.shift()).length;
		});
		const ceiling = setTimeout(
			() => kill(`timed out after ${timeoutMs / 1000} s`),
			timeoutMs,
		);
		child.on("error", (e) => {
			live.delete(pgid);
			settle({
				code: null,
				signal: null,
				killedFor: e.message,
				spawnCode: caught(e).code ?? null,
			});
		});
		child.on("close", (code, signal) => {
			live.delete(pgid);
			settle({ code, signal, killedFor: null, spawnCode: null });
		});
	});
}

module.exports = { killGroup, runGrouped };
