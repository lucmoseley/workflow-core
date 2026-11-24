const { spawnSync } = require("node:child_process");
const path = require("node:path");

/**
 * @typedef {{ claimed: true, warning?: string } | { claimed: false, why: string }} ClaimResult
 */

/**
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

/** @param {import("node:child_process").SpawnSyncReturns<string>} r */
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
