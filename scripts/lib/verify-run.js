const { execSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

// workflow-core#1268 guess
const TAIL_LINES = 80;

/** @param {Buffer | string | undefined} stream */
function tail(stream) {
	const lines = (stream ?? "").toString().trimEnd().split("\n");
	if (lines.length <= TAIL_LINES) return lines.join("\n");
	const cut = lines.length - TAIL_LINES;
	return [`… ${cut} earlier lines cut`, ...lines.slice(cut)].join("\n");
}

/**
 * @param {string} command
 * @param {{cwd: string, env?: NodeJS.ProcessEnv, timeout?: number}} opts
 * @returns {{ok: true} | {ok: false, status: number|null, said: string,
 *   message: string, timedOut: boolean, suffix: string}}
 */
function runVerify(command, { cwd, env, timeout }) {
	try {
		execSync(command, {
			cwd,
			stdio: "pipe",
			maxBuffer: CHILD_MAX_BUFFER,
			env,
			timeout,
		});
		return { ok: true };
	} catch (err) {
		const e = /** @type {{status?: unknown, stdout?: Buffer, stderr?: Buffer,
				code?: string, message?: string}} */ (err);
		const timedOut = e.code === "ETIMEDOUT";
		return {
			ok: false,
			status: typeof e.status === "number" ? e.status : null,
			said: [tail(e.stdout), tail(e.stderr)].filter(Boolean).join("\n"),
			message: e.message ?? "no detail",
			timedOut,
			suffix: timedOut ? ` — killed after exceeding ${timeout}ms` : "",
		};
	}
}

module.exports = { runVerify };
