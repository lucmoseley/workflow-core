/*
 * canonical-json.js — JSON.stringify with keys optionally sorted (by UTF-8
 * bytes), so two values equal in content serialise equal whatever their key
 * order: the echo chain's call signature and the outcome review's duplicate
 * log-line check (#4861).
 */

/**
 * @param {unknown} value
 * @param {boolean} sortKeys
 * @returns {string}
 */
function canonicalJson(value, sortKeys) {
	/** @type {(v: unknown) => unknown} */
	const order = (v) => {
		if (Array.isArray(v)) return v.map(order);
		if (!v || typeof v !== "object") return v;
		const keys = Object.keys(v);
		if (sortKeys)
			keys.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const k of keys)
			out[k] = order(/** @type {Record<string, unknown>} */ (v)[k]);
		return out;
	};
	return JSON.stringify(order(value));
}

module.exports = { canonicalJson };
