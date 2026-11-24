const fs = require("node:fs");
const path = require("node:path");

/** @typedef {{ notify: boolean, persisting: boolean }} StampCtx */

const base = () => require("./notify-report.js").base();

/** @param {string} checker */
const stampFile = (checker) => path.join(base(), `${checker}.notified`);

const HIGH_WATER = "max:";

/** @param {number|string} value */
const highWater = (value) => `${HIGH_WATER}${value}`;

/**
 * @param {string} seen
 * @param {string} signature
 */
function covers(seen, signature) {
	const want = Number(signature.slice(HIGH_WATER.length));
	const had = Number(seen.slice(HIGH_WATER.length));
	const ordered =
		signature.startsWith(HIGH_WATER) &&
		seen.startsWith(HIGH_WATER) &&
		Number.isFinite(want) &&
		Number.isFinite(had);
	return ordered ? want <= had : seen === signature;
}

/**
 * @param {string} checker
 * @returns {string | null}
 */
function readStamp(checker) {
	try {
		return fs.readFileSync(stampFile(checker), "utf8").trim();
	} catch {
		return null;
	}
}

/**
 * @param {string} checker
 * @param {string} signature
 * @returns {boolean}
 */
function recordDelivery(checker, signature) {
	try {
		fs.mkdirSync(base(), { recursive: true });
		fs.writeFileSync(stampFile(checker), signature);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} checker
 * @returns {boolean}
 */
function clearDelivery(checker) {
	try {
		fs.rmSync(stampFile(checker), { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {string} checker
 * @param {string} signature
 */
function delivered(checker, signature) {
	const seen = readStamp(checker);
	return seen !== null && covers(seen, signature);
}

/**
 * @param {StampCtx} ctx
 * @param {string} checker
 * @returns {string | null}
 */
function readSeenStamp(ctx, checker) {
	if (!ctx.notify || ctx.persisting) return null;
	return readStamp(checker);
}

/**
 * @param {StampCtx} ctx
 * @param {string} checker
 * @returns {number|null}
 */
function readSeenHighWater(ctx, checker) {
	const seen = readSeenStamp(ctx, checker);
	if (seen === null || !seen.startsWith(HIGH_WATER)) return null;
	const ms = Number(seen.slice(HIGH_WATER.length));
	return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {StampCtx} ctx
 * @param {string} checker
 * @param {string} signature
 */
function alreadyDelivered(ctx, checker, signature) {
	const seen = readSeenStamp(ctx, checker);
	return seen !== null && covers(seen, signature);
}

/**
 * @param {StampCtx} ctx
 * @param {string} checker
 * @param {string} signature
 */
function markDelivered(ctx, checker, signature) {
	if (!ctx.notify || ctx.persisting) return;
	recordDelivery(checker, signature);
}

module.exports = {
	highWater,
	stampFile,
	readStamp,
	recordDelivery,
	clearDelivery,
	delivered,
	readSeenStamp,
	readSeenHighWater,
	alreadyDelivered,
	markDelivered,
};
