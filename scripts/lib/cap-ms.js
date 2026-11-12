/*
 * cap-ms.js — the one reader of a timeout knob (#5104): every
 * `WFC_*_MS` ceiling a test or an operator may move goes through it, so a
 * garbled value falls back to the shipped ceiling in one place rather than
 * per caller.
 */

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
