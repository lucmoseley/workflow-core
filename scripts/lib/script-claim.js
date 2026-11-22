/*
 * script-claim.js — the one spawn of `session-arbiter.js claim` and `release`
 * for a script that writes a tracked file under its own claim (workflow-core#4719). The
 * claim guard sees Write and Edit only, never a script's write, so such a
 * script claims by the arbiter's CLI; each caller keeps its own policy on a
 * refusal.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

/**
 * @typedef {{ claimed: true, warning?: string } | { claimed: false, why: string }} ClaimResult
 */

/**
 * `verb` run on `subject` by the arbiter's CLI, or by `cmd` standing in for
 * it with the verb left out.
 * @param {"claim" | "release"} verb
 * @param {string[]} args
 * @param {{ cmd?: string | null, cwd?: string, timeoutMs?: number }} opts
 */
function runArbiter(verb, args, { cmd, cwd, timeoutMs }) {
	const [bin, binArgs] = cmd
		? [cmd, args]
		: [
				process.execPath,
				[path.join(__dirname, "..", "session-arbiter.js"), verb, ...args],
			];
	return spawnSync(bin, binArgs, { cwd, encoding: "utf8", timeout: timeoutMs });
}

/**
 * Why a spawn did not exit 0: its output, else its spawn error, else its exit.
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 */
function whyFailed(r) {
	return (
		`${r.stderr ?? ""}${r.stdout ?? ""}`.trim() ||
		r.error?.message ||
		`the arbiter exited ${r.status ?? r.signal}`
	);
}

/**
 * @param {string} subject
 * @param {string | null | undefined} session
 * @param {boolean} generator
 */
function argsFor(subject, session, generator) {
	return [
		subject,
		...(session ? [session] : []),
		...(generator ? ["--generator"] : []),
	];
}

/**
 * `subject` claimed through the arbiter's CLI. Exit 0 is `claimed`, a
 * contended claim included, and its stderr, the warning naming the live
 * neighbour that also holds the subject (workflow-core#4249), is `warning`. Any other exit,
 * a timeout or a failed spawn is `why`.
 *
 * `claimCmd` stands in for the arbiter, for tests: it is run with the subject
 * as `$1`, then the session, then `--generator`.
 *
 * @param {string} subject
 * @param {{ claimCmd?: string | null, session?: string | null, cwd?: string,
 *   timeoutMs?: number, generator?: boolean }} [opts]
 * @returns {ClaimResult}
 */
function claimByArbiter(
	subject,
	{ claimCmd, session, cwd, timeoutMs, generator = false } = {},
) {
	const r = runArbiter("claim", argsFor(subject, session, generator), {
		cmd: claimCmd,
		cwd,
		timeoutMs,
	});
	if (r.status === 0) {
		const warning = r.stderr?.trim();
		return warning ? { claimed: true, warning } : { claimed: true };
	}
	return { claimed: false, why: whyFailed(r) };
}

/**
 * A claim `claimByArbiter` took on `subject` given back, or why not. Release
 * only on `claimed`: a contended claim took nothing, and the arbiter refuses
 * to release a subject a neighbour holds (mantahostels#2422). `generator`
 * waives the dirty refusal a §A subject would earn from its own generator's
 * write (mantahostels#2428). `releaseCmd` stands in as `claimCmd` does.
 *
 * @param {string} subject
 * @param {{ releaseCmd?: string | null, generator?: boolean }} [opts]
 * @returns {{ released: true } | { released: false, why: string }}
 */
function releaseByArbiter(subject, { releaseCmd, generator = false } = {}) {
	const r = runArbiter("release", argsFor(subject, null, generator), {
		cmd: releaseCmd,
	});
	return r.status === 0
		? { released: true }
		: { released: false, why: whyFailed(r) };
}

module.exports = { claimByArbiter, releaseByArbiter };
