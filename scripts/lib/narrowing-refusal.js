const NARROWING_HEADLINE = "NARROWING FAILED, SO NOTHING RAN";

/**
 * @param {{ ruling: string, cause: unknown, wholeSuite: string }} refusal
 */
function narrowingRefusal({ ruling, cause, wholeSuite }) {
	const text = String(cause instanceof Error ? cause.message : cause);
	return (
		`\n${NARROWING_HEADLINE} ${ruling} — ${text.trim()}\n\n` +
		"A failed narrowing is never widened to the whole suite. Fix the cause and re-run, or run the whole suite on purpose:\n\n" +
		`  ${wholeSuite}\n\n`
	);
}

module.exports = { narrowingRefusal };
