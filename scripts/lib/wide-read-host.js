/*
 * wide-read-host.js — the production ports lib/wide-read.js reads (workflow-core#2791),
 * wired by both of its composition roots: the dispatcher's row for the Read
 * limb and scripts/guard-wide-read.js for the Bash limbs. A file's size, the
 * bytes a line window holds, and a glob's expansion.
 */

const fs = require("node:fs");
const path = require("node:path");
const { escapeRe, isGlobPattern } = require("./shell-words.js");

/**
 * How much of a file one read takes while counting a line window: 64 KiB,
 * Node's own default chunk for a file stream (fs.createReadStream's
 * highWaterMark). Not measured for this use.
 */
const CHUNK = 64 * 1024;

/**
 * Bytes on disk for a readable regular file; null for anything else.
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
		/* The port's contract: a path that cannot be stat'd or read answers
		 * null, and the core leaves it unjudged (workflow-core#2791). */
		return null;
	}
}

/**
 * The bytes lines `first` to `last` (1-based, inclusive) of a file hold, each
 * line's newline counted, as `sed -n "<first>,<last>p"` prints them. It stops
 * reading at the end of line `last`, so a huge file costs only the window
 * (workflow-core#1916). Null where the file cannot be read.
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
		/* The port's contract: a file that cannot be opened or read answers
		 * null, which the core logs and judges unchecked — a measure that
		 * failed is not a finding (mantahostels#147). */
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * One glob segment as a regex, bash's pattern grammar: `*`, `?`, a bracket
 * expression (`!` or `^` negating), a backslash quoting the next character.
 * @param {string} seg
 */
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
 * The bracket expression opening at `i`, as a regex class, and the index of
 * its `]`; null where none closes, so the `[` is literal.
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
 * One word's matches, bash's pathname expansion under nullglob: a leading `.`
 * matched only by a pattern spelling one, each directory's names sorted.
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
 * The names under `base` one pattern segment matches, joined to it, sorted.
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
		/* The port's contract: a directory that cannot be listed matches
		 * nothing, as nullglob expands an unreadable one (workflow-core#2791). */
		return [];
	}
	const re = segmentRe(seg);
	return names
		.sort()
		.filter((n) => re.test(n) && (!n.startsWith(".") || seg.startsWith(".")))
		.map((n) => path.join(base, n));
}

/**
 * What an unquoted `$lit` expands to: split on blanks, each part holding a
 * pattern character expanded under nullglob, any other kept as spelled.
 * Absolute, read from `cwd`.
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
