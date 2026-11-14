/*
 * fd-capture.js — a program's process-wide output and environment, swapped
 * so it can run inside another process (#5208): its fd 1 and fd 2 writes
 * handed to a taker rather than printed, and process.env replaced in place.
 * lib/program-scope.js runs a hook's programs in the post-commit dispatcher
 * on it, and lib/run-in-process.js a test's.
 *
 * THE TWO ROUTES this repo writes by are both taken: `fs.writeSync` on fd 1
 * and fd 2, which lib/write-fd.js writes through, and
 * `process.stdout.write` / `process.stderr.write`, which console goes
 * through. Every other fd writes as it would. A `fs.writeSync` is taken as
 * the text its data decodes to, whole.
 */

const fs = require("node:fs");

/* Buffer.isEncoding, not `typeof enc === "string"`: a Writable hands its _write
 * the chunk as a Buffer under the encoding "buffer", which is a string and is
 * not an encoding Buffer.toString will take. */
/** @type {(chunk: unknown, enc?: unknown) => string} */
const toText = (chunk, enc) =>
	typeof chunk === "string"
		? chunk
		: // `any`: Buffer.from has no overload taking `unknown`, and a stream
			// hands its write whatever the script passed.
			Buffer.from(/** @type {any} */ (chunk)).toString(
				typeof enc === "string" && Buffer.isEncoding(enc)
					? /** @type {BufferEncoding} */ (enc)
					: "utf8",
			);

/**
 * Replaces process.env in place. Mutation, not reassignment: a plain object
 * assigned over process.env stops child processes inheriting it natively,
 * and the programs run under it spawn git constantly.
 *
 * @param {Record<string, string | undefined>} env
 */
function replaceEnv(env) {
	for (const key of Object.keys(process.env))
		if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
}

/**
 * Hands every fd 1 and fd 2 write to `take` until the returned restore runs.
 * @param {(fd: 1 | 2, text: string) => void} take
 * @returns {() => void} puts back the writers this replaced
 */
function takeWrites(take) {
	const real = {
		writeSync: fs.writeSync,
		stdout: process.stdout.write,
		stderr: process.stderr.write,
	};
	/* `any`: writeSync's overloads cannot be assigned one arrow without a
	 * cast, and `data` and the rest are whatever the script passes, handed on
	 * untouched to the real function. */
	/** @type {any} */ (fs).writeSync = (
		/** @type {number} */ fd,
		/** @type {any} */ data,
		/** @type {any[]} */ ...rest
	) => {
		if (fd !== 1 && fd !== 2) return real.writeSync(fd, data, ...rest);
		const text = toText(data);
		take(fd, text);
		return Buffer.byteLength(text);
	};
	/* The callback forms are honoured because a script that passes one and
	 * never sees it called can wait forever. The `any`s, as on writeSync's:
	 * write's overloads take a chunk, an encoding or a callback in either
	 * second place. */
	/** @param {1 | 2} fd */
	const streamWrite = (fd) =>
		/** @type {any} */ (
			(/** @type {any} */ c, /** @type {any} */ e, /** @type {any} */ cb) => {
				take(fd, toText(c, e));
				const done = typeof e === "function" ? e : cb;
				if (done) done();
				return true;
			}
		);
	process.stdout.write = streamWrite(1);
	process.stderr.write = streamWrite(2);
	return () => {
		/** @type {any} */ (fs).writeSync = real.writeSync;
		process.stdout.write = real.stdout;
		process.stderr.write = real.stderr;
	};
}

module.exports = { replaceEnv, takeWrites, toText };
