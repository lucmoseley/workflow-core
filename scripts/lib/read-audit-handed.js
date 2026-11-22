const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");
const { PATH_MAX, toPosix } = require("./read-audit-paths.js");

/**
 * @typedef {{by: "arg", at: number, p: string[]}
 *   | {by: "env", name: string, standing: boolean, p: string[]}
 *   | {by: "stdin", p: string[]}
 *   | {by: "repo", p: string[]}} Hand
 */

/** @typedef {Map<string, string|null>} Settled */

/** @typedef {{cache: Settled, words: Set<string>}} Settling */

const STOPS = /[\s"';:]/;

const PARTS = /[\s"';:=,]+/;

const realpath = fs.realpathSync;
const lstat = fs.lstatSync;
const NO_THROW = { throwIfNoEntry: false };

const NAME_MAX = 255;

/** @param {string} root */
function buildHanded(root) {
	/** @param {string} abs */
	const relOf = (abs) => {
		const r = relativeUnder(root, abs);
		return r === null ? null : toPosix(r) || ".";
	};
	/**
	 * @param {string} abs
	 * @param {boolean} mustStand
	 */
	const realOf = (abs, mustStand) => {
		const got = tryRealpath(abs);
		if (typeof got === "string") return got;
		if (mustStand) return null;
		return got === UNREADABLE ? abs : (realOfDeepest(abs) ?? abs);
	};
	/**
	 * @param {string} word
	 * @returns {string[]}
	 */
	const spelt = (word) => {
		/** @type {Set<string>} */
		const out = new Set();
		for (
			let at = word.indexOf(root);
			at >= 0;
			at = word.indexOf(root, at + 1)
		) {
			const rest = word.slice(at + root.length).split(STOPS)[0] ?? "";
			out.add(rest.replace(/^\/+/, "") || ".");
		}
		return [...out];
	};
	/**
	 * @param {string} cwd
	 * @param {{text?: boolean}} [kind]
	 */
	const from = (cwd, { text = false } = {}) => {
		/** @type {Map<string, boolean>} */
		const known = new Map();
		const isHeld = (/** @type {string} */ name) => {
			let held = known.get(name);
			if (held === undefined) {
				try {
					held = lstat(path.join(cwd, name), NO_THROW) !== undefined;
				} catch {
					held = false;
				}
				known.set(name, held);
			}
			return held;
		};
		const gluedBy = text ? null : isHeld;
		/**
		 * @param {string} word
		 * @param {Settling} [settling]
		 * @returns {string[]}
		 */
		return (word, settling) => {
			const out = new Set(spelt(word));
			for (const tried of candidates(word, gluedBy)) {
				const real = realOfTried(cwd, tried, settling);
				const r = real === null ? null : relOf(real);
				if (r !== null) out.add(r);
			}
			return [...out];
		};
	};
	/**
	 * @param {string} cwd
	 * @param {string} tried
	 * @param {Settling} [settling]
	 */
	const realOfTried = (cwd, tried, settling) => {
		const abs = path.resolve(cwd, tried);
		if (settling?.words.has(tried)) {
			const { cache } = settling;
			if (!cache.has(abs)) cache.set(abs, realOf(abs, false));
			return cache.get(abs) ?? null;
		}
		const isBare = !tried.includes("/") && tried !== "." && tried !== "..";
		return realOf(abs, isBare);
	};
	return { spelt, from };
}

const UNREADABLE = Symbol("unreadable");

/**
 * @param {string} abs
 * @returns {string|null|typeof UNREADABLE}
 */
function tryRealpath(abs) {
	try {
		return realpath(abs);
	} catch (e) {
		const { code } = caught(e);
		return code === "ENOENT" || code === "ENOTDIR" ? null : UNREADABLE;
	}
}

/** @param {string} abs */
function realOfDeepest(abs) {
	const parts = abs.split(path.sep).slice(1);
	let real = tryRealpath(path.sep);
	let stands = 0;
	let fails = parts.length;
	while (typeof real === "string" && fails - stands > 1) {
		const mid = (stands + fails) >> 1;
		const got = tryRealpath(path.sep + parts.slice(0, mid).join(path.sep));
		if (got === UNREADABLE) return null;
		if (got === null) fails = mid;
		else {
			real = got;
			stands = mid;
		}
	}
	return typeof real === "string"
		? path.join(real, ...parts.slice(stands))
		: null;
}

/** @param {string} value */
function absoluteWords(value) {
	return new Set([...candidates(value, null)].filter(path.isAbsolute));
}

/**
 * @param {string} word
 * @param {((name: string) => boolean)|null} isHeld
 * @returns {Set<string>}
 */
function candidates(word, isHeld) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const piece of [word, ...word.split(PARTS)]) {
		for (const from of [0, piece.indexOf("/"), piece.search(/\.\.?\//)]) {
			const tried = from < 0 ? "" : piece.slice(from);
			if (tried && tried.length <= PATH_MAX) out.add(tried);
		}
		if (isHeld === null || piece.length > PATH_MAX) continue;
		for (const tried of glued(piece, isHeld)) out.add(tried);
	}
	return out;
}

/**
 * @param {string} piece
 * @param {(name: string) => boolean} isHeld
 * @returns {string[]}
 */
function glued(piece, isHeld) {
	const isShort = piece[0] === "-" && piece[1] !== "-";
	if (!isShort && piece[0] !== "@") return [];
	const slash = piece.indexOf("/");
	const end = slash < 0 ? piece.length : slash;
	/** @type {string[]} */
	const out = [];
	for (let at = Math.max(1, end - NAME_MAX); at < end; at++) {
		const name = piece.slice(at, end);
		const isDots = name === "." || name === "..";
		const isCluster = isShort && at >= 2;
		if (isDots ? isCluster : isHeld(name)) out.push(piece.slice(at));
	}
	return out;
}

module.exports = { absoluteWords, buildHanded };
