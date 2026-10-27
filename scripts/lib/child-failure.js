/*
 * child-failure.js — the verdict on a spawned child's result: why it failed,
 * or null where it exited 0 (#3029). It is its own module so refill-loop.js
 * and claude-attach.contract.test.ts judge a child by the same verdict.
 */

/** @typedef {{status: number|null, error?: Error, stdout?: string, stderr?: string}} ChildResult */
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

module.exports = { childFailure, childVerdict };
