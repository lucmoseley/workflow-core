/**
 * @param {string} out
 * @returns {any | null}
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
