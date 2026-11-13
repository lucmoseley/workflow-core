/*
 * verify-run.js — runs a Verify shell command and normalizes what
 * `execSync` throws (`scripts/lib/upgrade-walk.js`'s `verifyPasses` and its walk
 * loop, `scripts/release-plugin.js`'s `verifyOrThrow`) (workflow-core#305).
 *
 * A timeout kill and any other signal death both leave `err.signal` set, so
 * a bare `e.signal != null` check misreads a live-hazard SIGKILL (earlyoom,
 * a manual interrupt) as "killed after exceeding Nms". `timedOut` instead
 * reads `err.code === "ETIMEDOUT"`, which Node sets only when the `timeout`
 * option itself elapsed.
 */

const { execSync } = require("node:child_process");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/* A failing suite's verdict can sit at the foot of thousands of stdout lines,
 * and `said` lands whole in a thrown refusal. 80 is a guess at a vitest
 * summary plus a few failures, never sized against a real log. Residual: a
 * failure printed above the last 80 lines of its stream is cut away. */
const TAIL_LINES = 80;

/** @param {Buffer | string | undefined} stream */
function tail(stream) {
	const lines = (stream ?? "").toString().trimEnd().split("\n");
	if (lines.length <= TAIL_LINES) return lines.join("\n");
	const cut = lines.length - TAIL_LINES;
	return [`… ${cut} earlier lines cut`, ...lines.slice(cut)].join("\n");
}

/**
 * @param {string} command a shell command
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
			/* Both streams: `npm run test` writes its verdict to stdout, and a
			 * stderr-only read reported that refusal blank (workflow-core#1268). */
			said: [tail(e.stdout), tail(e.stderr)].filter(Boolean).join("\n"),
			message: e.message ?? "no detail",
			timedOut,
			suffix: timedOut ? ` — killed after exceeding ${timeout}ms` : "",
		};
	}
}

module.exports = { runVerify };
