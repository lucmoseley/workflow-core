/** @typedef {{status: number|null, signal?: NodeJS.Signals|null, error?: Error, stdout?: string, stderr?: string}} ChildResult */

/**
 * @template {ChildResult} R
 * @param {R} run
 * @returns {R}
 */
const withoutLateEpipe = (run) =>
	/** @type {NodeJS.ErrnoException | undefined} */ (run.error)?.code ===
		"EPIPE" &&
	(run.status !== null || (run.signal ?? null) !== null)
		? { ...run, error: undefined }
		: run;

/** @typedef {{failed: string|null, out: string}} ChildVerdict */

/**
 * @param {ChildResult} r
 * @returns {ChildVerdict}
 */
const childVerdict = (r) => ({
	failed:
		r.status === 0
			? null
			: `exit ${r.status}${r.error ? ` (${r.error.message})` : ""}`,
	out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
});

/** @param {ChildVerdict} v */
const childFailure = ({ failed, out }) =>
	failed && [failed, out.split("\n").pop()].filter(Boolean).join(": ");

module.exports = { childFailure, childVerdict, withoutLateEpipe };
