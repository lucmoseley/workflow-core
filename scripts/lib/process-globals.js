const fs = require("node:fs");

/** @type {(chunk: unknown, enc?: unknown) => string} */
const toText = (chunk, enc) =>
	typeof chunk === "string"
		? chunk
		: Buffer.from(/** @type {any} */ (chunk)).toString(
				typeof enc === "string" && Buffer.isEncoding(enc)
					? /** @type {BufferEncoding} */ (enc)
					: "utf8",
			);

/** @param {Record<string, string | undefined>} env */
function replaceEnv(env) {
	for (const key of Object.keys(process.env))
		if (!(key in env)) delete process.env[key];
	for (const [key, value] of Object.entries(env))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
}

/**
 * @param {(fd: 1 | 2, text: string) => void} take
 * @returns {() => void}
 */
function takeWrites(take) {
	const real = {
		writeSync: fs.writeSync,
		stdout: process.stdout.write,
		stderr: process.stderr.write,
	};
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
