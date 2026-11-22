const fs = require("node:fs");
const path = require("node:path");
const { escapeRe } = require("./regex-group.js");
const { isGlobPattern } = require("./shell-words.js");

const CHUNK = 64 * 1024;

/**
 * @param {string} p
 * @returns {number | null}
 */
function fileBytes(p) {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return null;
		fs.accessSync(p, fs.constants.R_OK);
		return st.size;
	} catch {
		return null;
	}
}

/**
 * @param {string} p
 * @param {number} first
 * @param {number} last
 * @returns {number | null}
 */
function windowBytes(p, first, last) {
	let fd;
	try {
		fd = fs.openSync(p, "r");
		const buf = Buffer.alloc(CHUNK);
		let line = 1;
		let bytes = 0;
		for (;;) {
			const n = fs.readSync(fd, buf, 0, CHUNK, null);
			if (n === 0) return bytes;
			for (let i = 0; i < n; i++) {
				if (line >= first) bytes++;
				if (buf[i] === 0x0a && line++ >= last) return bytes;
			}
		}
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** @param {string} seg */
function segmentRe(seg) {
	let re = "";
	for (let i = 0; i < seg.length; i++) {
		const c = seg.charAt(i);
		const bracket = c === "[" ? bracketAt(seg, i) : null;
		if (bracket) {
			re += bracket.re;
			i = bracket.end;
		} else if (c === "\\" && i + 1 < seg.length)
			re += escapeRe(seg.charAt(++i));
		else re += GLOB_CHARS[c] ?? escapeRe(c);
	}
	return new RegExp(`^${re}$`);
}

/** @type {Record<string, string>} */
const GLOB_CHARS = { "*": "[^/]*", "?": "[^/]" };

/**
 * @param {string} seg
 * @param {number} i
 */
function bracketAt(seg, i) {
	const end = seg.indexOf("]", i + 2);
	if (end < 0) return null;
	let body = seg.slice(i + 1, end);
	const negate = body.startsWith("!") || body.startsWith("^");
	if (negate) body = body.slice(1);
	return {
		re: `[${negate ? "^" : ""}${body.replace(/[\\\]]/g, "\\$&")}]`,
		end,
	};
}

/**
 * @param {string} word
 * @param {string} cwd
 * @returns {string[]}
 */
function expandWord(word, cwd) {
	let found = [word.startsWith("/") ? "/" : ""];
	for (const seg of word.split("/")) {
		if (seg === "") continue;
		found = found.flatMap((base) =>
			isGlobPattern(seg)
				? readMatching(base, seg, cwd)
				: [path.join(base, seg)],
		);
	}
	return found
		.filter((f) => f !== "" && fs.existsSync(path.resolve(cwd, f)))
		.map((f) => path.resolve(cwd, f));
}

/**
 * @param {string} base
 * @param {string} seg
 * @param {string} cwd
 * @returns {string[]}
 */
function readMatching(base, seg, cwd) {
	let names;
	try {
		names = fs.readdirSync(path.resolve(cwd, base || "."));
	} catch {
		return [];
	}
	const re = segmentRe(seg);
	return names
		.sort()
		.filter((n) => re.test(n) && (!n.startsWith(".") || seg.startsWith(".")))
		.map((n) => path.join(base, n));
}

/**
 * @param {string} lit
 * @param {string} cwd
 * @returns {string[]}
 */
function glob(lit, cwd) {
	return lit
		.split(/[ \t\n]+/)
		.filter(Boolean)
		.flatMap((w) =>
			isGlobPattern(w) ? expandWord(w, cwd) : [path.resolve(cwd, w)],
		);
}

/** @returns {import("./wide-read.js").WideReadPorts} */
function buildHostPorts() {
	return { fileBytes, windowBytes, glob };
}

module.exports = { buildHostPorts };
