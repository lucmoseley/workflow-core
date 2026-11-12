/**
 * A positive millisecond cap from `env`, else `fallback` — a garbled knob must
 * not disable the ceiling.
 * @param {string} env
 * @param {number} fallback
 * @returns {number}
 */
function capMs(env, fallback) {
	const n = Number(process.env[env]);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { capMs };
