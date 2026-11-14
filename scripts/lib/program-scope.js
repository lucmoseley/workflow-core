/*
 * program-scope.js — a CLI program's body run inside this process as its own
 * process would run it (#5208): under the caller's working directory and
 * environment, its fd 1 and fd 2 writes captured rather than printed.
 *
 * WHY: the post-commit dispatcher runs each of the hook's Node programs as a
 * row in one process, and a row hands back `{ exit, stdout, stderr }`
 * (lib/precommit-dispatch.js's RowResult). These programs were written for a
 * process of their own: they read `process.env` and `process.cwd()`, their
 * git children inherit both, and they print through lib/write-fd.js.
 *
 * WHAT IS SWAPPED, AND PUT BACK IN A `finally`:
 *
 *   env     replaced in place, never reassigned: a plain object assigned over
 *           process.env stops child processes inheriting it natively
 *           (lib/run-in-process.js's own reason).
 *   cwd     process.chdir to the caller's directory.
 *   output  `fs.writeSync` on fd 1 and fd 2, which lib/write-fd.js writes
 *           through, and `process.stdout.write` / `process.stderr.write`,
 *           which console goes through. Every other fd writes as it would.
 *
 * NOT REPRODUCED: a `process.exit` inside the body ends this process, and a
 * grandchild spawned with `stdio: "inherit"` writes to the real fd. The
 * programs run here return their exit code and spawn neither way.
 *
 * One body at a time: the swap is global to the process, so two overlapping
 * bodies would restore each other's state. The dispatcher runs its rows in
 * sequence.
 */

const fs = require("node:fs");

/**
 * @typedef {{ cwd: string, env: NodeJS.ProcessEnv }} ProcessIo
 * @typedef {{ exit: number, stdout: string, stderr: string }} ProgramResult
 */

/** @param {NodeJS.ProcessEnv} env */
function replaceEnv(env) {
	for (const key of Object.keys(process.env))
		if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/**
 * Enter `io`, returning the restore.
 * @param {ProcessIo} io
 */
function enter({ cwd, env }) {
	const saved = { cwd: process.cwd(), env: { ...process.env } };
	replaceEnv(env);
	try {
		process.chdir(cwd);
	} catch (e) {
		replaceEnv(saved.env);
		throw e;
	}
	return () => {
		replaceEnv(saved.env);
		process.chdir(saved.cwd);
	};
}

/**
 * Run `body` under `io`'s working directory and environment, restored after
 * it returns, throws, or (for a promise) settles.
 * @template T
 * @param {ProcessIo} io
 * @param {() => T} body
 * @returns {T}
 */
function inProgramScope(io, body) {
	const restore = enter(io);
	let result;
	try {
		result = body();
	} catch (e) {
		restore();
		throw e;
	}
	if (result instanceof Promise)
		return /** @type {T} */ (result.finally(restore));
	restore();
	return result;
}

/**
 * The bytes a `fs.writeSync` call writes, by either of its signatures.
 * @param {unknown} data
 * @param {unknown[]} rest
 * @returns {Buffer}
 */
function bytesOf(data, rest) {
	if (typeof data === "string")
		return Buffer.from(
			data,
			/** @type {BufferEncoding} */ (
				typeof rest[1] === "string" ? rest[1] : "utf8"
			),
		);
	const view = /** @type {NodeJS.ArrayBufferView} */ (data);
	const offset = typeof rest[0] === "number" ? rest[0] : 0;
	const length =
		typeof rest[1] === "number" ? rest[1] : view.byteLength - offset;
	return Buffer.from(
		Buffer.from(view.buffer, view.byteOffset + offset, length),
	);
}

/**
 * Run `body`, an exit code's producer, with its fd 1 and fd 2 writes
 * captured.
 * @param {() => number} body
 * @returns {ProgramResult}
 */
function captured(body) {
	/** @type {Record<1 | 2, Buffer[]>} */
	const taken = { 1: [], 2: [] };
	const realWriteSync = fs.writeSync;
	const realOut = process.stdout.write;
	const realErr = process.stderr.write;
	/** @param {1 | 2} fd */
	const streamWrite =
		(fd) =>
		/** @param {string | Uint8Array} chunk @param {...unknown} rest */
		(chunk, ...rest) => {
			const encoding = typeof rest[0] === "string" ? rest[0] : "utf8";
			taken[fd].push(
				typeof chunk === "string"
					? Buffer.from(chunk, /** @type {BufferEncoding} */ (encoding))
					: Buffer.from(chunk),
			);
			const done = rest.find((r) => typeof r === "function");
			if (done) /** @type {() => void} */ (done)();
			return true;
		};
	fs.writeSync = /** @type {typeof fs.writeSync} */ (
		/** @param {number} fd @param {unknown} data @param {...unknown} rest */
		(fd, data, ...rest) => {
			if (fd !== 1 && fd !== 2)
				return realWriteSync(
					fd,
					/** @type {string} */ (data),
					.../** @type {[]} */ (rest),
				);
			const bytes = bytesOf(data, rest);
			taken[fd].push(bytes);
			return bytes.length;
		}
	);
	process.stdout.write = /** @type {typeof process.stdout.write} */ (
		streamWrite(1)
	);
	process.stderr.write = /** @type {typeof process.stderr.write} */ (
		streamWrite(2)
	);
	let exit;
	try {
		exit = body();
	} finally {
		fs.writeSync = realWriteSync;
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	}
	return {
		exit,
		stdout: Buffer.concat(taken[1]).toString("utf8"),
		stderr: Buffer.concat(taken[2]).toString("utf8"),
	};
}

/**
 * A program's run in this process: `body` returns its exit code, and what it
 * writes to fd 1 and fd 2 comes back as stdout and stderr.
 * @param {ProcessIo} io
 * @param {() => number} body
 * @returns {ProgramResult}
 */
const runProgram = (io, body) => inProgramScope(io, () => captured(body));

module.exports = { inProgramScope, runProgram };
