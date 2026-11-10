/*
 * narrowing-refusal.js — what a runner prints where narrowing a run to the
 * session's own work failed: nothing ran, and the failure is never widened to
 * the whole suite (#2698 for vitest, #2934 for pytest).
 */

/* The refusal's first words, which both runners' tests pin. */
const NARROWING_LINE = "NARROWING FAILED, SO NOTHING RAN";

/**
 * @param {{ ruling: string, cause: unknown, wholeSuite: string }} refusal
 *   `ruling` the ticket that ruled this runner's refusal, `cause` what failed,
 *   `wholeSuite` the command that runs the whole suite on purpose
 */
function narrowingRefusal({ ruling, cause, wholeSuite }) {
	const text = cause instanceof Error ? cause.message : String(cause);
	return (
		`\n${NARROWING_LINE} (${ruling}) — ${text.trim()}\n\n` +
		"A failed narrowing is never widened to the whole suite. Fix the cause and re-run, or run the whole suite on purpose:\n\n" +
		`  ${wholeSuite}\n\n`
	);
}

module.exports = { NARROWING_LINE, narrowingRefusal };
