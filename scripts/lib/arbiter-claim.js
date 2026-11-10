/*
 * arbiter-claim.js — the one spawn of `session-arbiter.js claim` for a script
 * that writes a tracked file under its own claim (#4719). The claim guard sees
 * Write and Edit only, never a script's write, so such a script claims by the
 * arbiter's CLI; each caller keeps its own policy on a refusal.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");

/**
 * @typedef {{ claimed: true, warning?: string } | { claimed: false, why: string }} ClaimResult
 */

/**
 * `subject` claimed through the arbiter's CLI. Exit 0 is `claimed`, a
 * contended claim included: the arbiter then took nothing, and its stderr, the
 * warning naming the live neighbour that also holds the subject (#4249), is
 * `warning`. Any other exit, a timeout or a failed spawn is `why`.
 *
 * `claimCmd` stands in for the arbiter, for tests: it is run with the subject
 * as `$1`, then the session, then `--generator`, which is the arbiter's own
 * argument order after `claim`.
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
	const args = [
		subject,
		...(session ? [session] : []),
		...(generator ? ["--generator"] : []),
	];
	const [cmd, cmdArgs] = claimCmd
		? [claimCmd, args]
		: [
				process.execPath,
				[path.join(__dirname, "..", "session-arbiter.js"), "claim", ...args],
			];
	const r = spawnSync(cmd, cmdArgs, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
	});
	if (r.status === 0) {
		const warning = r.stderr?.trim();
		return warning ? { claimed: true, warning } : { claimed: true };
	}
	return {
		claimed: false,
		why:
			`${r.stderr ?? ""}${r.stdout ?? ""}`.trim() ||
			r.error?.message ||
			`the arbiter exited ${r.status ?? r.signal}`,
	};
}

module.exports = { claimByArbiter };
