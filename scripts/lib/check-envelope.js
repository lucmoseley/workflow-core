/*
 * check-envelope.js — reading a checker's `--json` envelope off its stdout,
 * for the daily repo-checks run, which judges every check by it (#1548).
 * It sits in lib/ beside lib/check.js, which writes the envelope, so the
 * writer's last-on-stdout promise and the reader that leans on it change
 * together.
 */

/**
 * A checker's stdout, parsed — null where it is not one JSON object.
 *
 * Tolerates leading noise on stdout (a `console.log` from a dependency, a
 * deprecation notice) by taking the text from the first `{` on: lib/check.js
 * writes the envelope last and writes nothing after it.
 *
 * @param {string} out
 * @returns {any | null} `any`: a checker's own payload rides in the
 *   envelope beside the frame, so its shape is each checker's own
 */
function parseEnvelope(out) {
	const start = out.indexOf("{");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(out.slice(start));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: null;
	} catch {
		return null;
	}
}

module.exports = { parseEnvelope };
