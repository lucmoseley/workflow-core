/*
 * read-audit-handed.js — the checkout paths a word hands a child process
 * (#4982): an argument, an environment variable's value or its standard
 * input. The read audit's preload (lib/read-audit-preload.js) asks at the
 * spawn, while the links a word goes through still stand.
 *
 * Spelt: the root's own absolute spelling anywhere in it, up to what ends a
 * path. Resolved: the word, a piece of it, or a piece from its first `/`,
 * `./` or `../` (`-C/tmp/link`, `-I../x`) that, read against the child's
 * working directory with every link followed, lands under the root —
 * `../../<root>/x` from outside, or a link to the checkout. A candidate
 * holding no `/` is a path only where it stands in that directory.
 *
 * Residual: a relative path glued behind a prefix with no `./` or `../` to
 * start it (`-Iin/x`, `in` a link) is resolved only as the whole piece.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");

/**
 * What handed a child a checkout path, as the preload logs it on the
 * child's entry: an argument by its place after the program's name; a
 * variable by its name, `standing` where the process that spawned the child
 * holds the same value; the input of a sync spawn. `p` is the repo-relative
 * paths it names.
 * @typedef {{by: "arg", at: number, p: string[]}
 *   | {by: "env", name: string, standing: boolean, p: string[]}
 *   | {by: "stdin", p: string[]}} Hand
 */

/* What ends a path inside a word. */
const STOPS = /[\s"';:]/;

/* What parts one path from the next: the stops, and what sets an option's
 * value off its name or lists several. */
const PARTS = /[\s"';:=,]+/;

/* Taken as this module loads, before the preload wraps `fs`. */
const realpath = fs.realpathSync;

/* Linux's PATH_MAX: a longer piece is no path the kernel would take. */
const PATH_MAX = 4096;

/** @param {string} root real path */
function buildHanded(root) {
	/** @param {string} abs */
	const relOf = (abs) => {
		const r = relativeUnder(root, abs);
		return r === null ? null : r.split(path.sep).join("/") || ".";
	};
	/**
	 * `abs` with its links followed, through the deepest part of it that
	 * stands; null where `mustStand` and it does not, as given where it
	 * cannot be read.
	 * @param {string} abs
	 * @param {boolean} mustStand
	 */
	const realOf = (abs, mustStand) => {
		/** @type {string[]} */
		const tail = [];
		for (let head = abs; ; ) {
			try {
				return path.join(realpath(head), ...tail);
			} catch (e) {
				if (mustStand) return null;
				const { code } = caught(e);
				const up = path.dirname(head);
				if ((code !== "ENOENT" && code !== "ENOTDIR") || up === head)
					return abs;
				tail.unshift(path.basename(head));
				head = up;
			}
		}
	};
	/**
	 * The repo-relative paths `word` spells by the root's absolute name.
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
	 * The repo-relative paths `word` names, spelt or resolved from `cwd`.
	 * @param {string} word
	 * @param {string} cwd the child's working directory, real path
	 * @returns {string[]}
	 */
	const named = (word, cwd) => {
		const out = new Set(spelt(word));
		for (const tried of candidates(word)) {
			const isBare = !tried.includes("/") && tried !== "." && tried !== "..";
			const real = realOf(path.resolve(cwd, tried), isBare);
			const r = real === null ? null : relOf(real);
			if (r !== null) out.add(r);
		}
		return [...out];
	};
	return { spelt, named };
}

/**
 * @param {string} word
 * @returns {Set<string>}
 */
function candidates(word) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const piece of [word, ...word.split(PARTS)])
		for (const from of [0, piece.indexOf("/"), piece.search(/\.\.?\//)]) {
			const tried = from < 0 ? "" : piece.slice(from);
			if (tried && tried.length <= PATH_MAX) out.add(tried);
		}
	return out;
}

module.exports = { buildHanded };
