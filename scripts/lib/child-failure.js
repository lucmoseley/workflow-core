/*
 * child-failure.js — how a spawned child's result is judged: the verdict,
 * why it failed or null where it exited 0 (#3029), and the EPIPE a child
 * leaves by exiting before it read its input, dropped (#5416). It is its own
 * module so every spawnSync caller judges a child by the same rules.
 */

/** @typedef {{status: number|null, signal?: NodeJS.Signals|null, error?: Error, stdout?: string, stderr?: string}} ChildResult */

/**
 * A child that ends before reading all of its `input` leaves spawnSync an
 * EPIPE beside its real exit status or signal, which is the answer, so the
 * EPIPE is dropped (#3825, #5416). Any other error, or an EPIPE from a child
 * that never ended, stands.
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
 * The exit, and the error that ended it, else null on exit 0; and everything
 * the child printed, trimmed.
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

/**
 * The last line the child printed carries the reason.
 * @param {ChildVerdict} v
 */
const childFailure = ({ failed, out }) =>
	failed && [failed, out.split("\n").pop()].filter(Boolean).join(": ");

module.exports = { childFailure, childVerdict, withoutLateEpipe };
