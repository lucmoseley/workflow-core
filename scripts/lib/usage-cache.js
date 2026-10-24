/*
 * usage-cache.js — the one parse of a seat's `cachedUsageUtilization`, shared
 * by `allowance.js` and `seat-utilisation.js` (#377). Bars are read off
 * `utilization.limits[]` by `kind`, never the `seven_day` / `five_hour` keys.
 *
 * **Residual:** a cache holding those keys but no matching `limits[]` bar now
 * reads its figure as null, so the seat reads as unread and blocks the fire.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/**
 * One `limits[]` entry. Fields the cache omits or mistypes read null.
 * @typedef {{ kind: string | null, percent: number | null, severity: string | null, resetsAt: string | null, model: string | null }} LimitBar
 */

/**
 * @typedef {{ state: "missing" } | { state: "unreadable" } | { state: "ok", fetchedAtMs: number | null, accountUuid: string | null, bars: LimitBar[] }} UsageCache
 */

/**
 * `cachedUsageUtilization` out of `<configDir>/.claude.json`. `missing` is no
 * file at all; `unreadable` is any other read or parse failure, or no such
 * key. Never throws.
 * @param {string} configDir
 * @returns {UsageCache}
 */
function readUsageCache(configDir) {
	let parsed;
	try {
		parsed = JSON.parse(
			fs.readFileSync(path.join(configDir, ".claude.json"), "utf8"),
		);
	} catch (e) {
		return { state: caught(e).code === "ENOENT" ? "missing" : "unreadable" };
	}
	const cache = parsed?.cachedUsageUtilization;
	if (!cache || typeof cache !== "object") return { state: "unreadable" };
	const limits = cache.utilization?.limits;
	const str = (/** @type {unknown} */ v) => (typeof v === "string" ? v : null);
	const num = (/** @type {unknown} */ v) => (typeof v === "number" ? v : null);
	return {
		state: "ok",
		fetchedAtMs: num(cache.fetchedAtMs),
		accountUuid: str(cache.accountUuid),
		bars: (Array.isArray(limits) ? limits : []).map((l) => ({
			kind: str(l?.kind),
			percent: num(l?.percent),
			severity: str(l?.severity),
			resetsAt: str(l?.resets_at),
			model: str(l?.scope?.model?.display_name),
		})),
	};
}

/**
 * Whether a bar's window has rolled: `resetsAt` parses and `now` is at or past
 * it. What a caller does with a rolled bar is its own (#377 ruling 2).
 * @param {string | null} resetsAt
 * @param {number} now
 */
function hasResetPassed(resetsAt, now) {
	const at = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
	return Number.isFinite(at) && now >= at;
}

module.exports = { readUsageCache, hasResetPassed };
