/*
 * shell-operands.js — a shell script's text with what is not a path operand
 * blanked, for a reader scanning it for paths (#4567).
 */

/** A heredoc's opening, its delimiter captured. */
const HEREDOC = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/;

/** @param {string} t */
const blank = (t) => t.replace(/[^\n]/g, " ");

/**
 * Where `shellOperands` stands between characters: inside a heredoc whose
 * delimiter it holds, or inside a quoted string, the text so far held back.
 * @typedef {{ heredoc: string | null, quote: string | null, quoted: string, keepQuoted: boolean }} ShellState
 */

/**
 * One line's operands outside a heredoc, the state carried to the next line
 * updated.
 * @param {string} line
 * @param {ShellState} st
 * @returns {string}
 */
function shellLineOperands(line, st) {
	let out = "";
	let i = 0;
	while (i < line.length) {
		const c = line.charAt(i);
		if (st.quote) {
			const run = quotedRun(line, i, st);
			out += run.text;
			i = run.end;
		} else if (c === "#" && /^$|[\s;|&(]$/.test(line.charAt(i - 1))) {
			return out + blank(line.slice(i));
		} else {
			if (c === "'" || c === '"') {
				st.quote = c;
				st.quoted = c;
			} else out += c;
			i++;
		}
	}
	st.heredoc = st.quote ? null : (HEREDOC.exec(line)?.[1] ?? null);
	return out;
}

/**
 * Reads on through an open quoted string from `i`, to its close or the end
 * of the line, holding it back in `st.quoted`.
 * @param {string} line
 * @param {number} i
 * @param {ShellState} st
 * @returns {{ text: string, end: number }}  the closed string's operand
 *   text, "" while it is still open, and where reading stopped
 */
function quotedRun(line, i, st) {
	for (let j = i; j < line.length; j++) {
		const c = line.charAt(j);
		const escaped = c === "\\" && st.quote === '"';
		st.quoted += escaped ? c + line.charAt(j + 1) : c;
		if (escaped) j++;
		else if (c === st.quote) return { text: closeQuote(st), end: j + 1 };
	}
	return { text: "", end: line.length };
}

/**
 * A closed quoted string as an operand: kept whole, or blanked where it
 * holds a space and so is prose.
 * @param {ShellState} st
 * @returns {string}
 */
function closeQuote(st) {
	st.quote = null;
	return !st.keepQuoted && /\s/.test(st.quoted) ? blank(st.quoted) : st.quoted;
}

/**
 * A shell script's text with what is not a path operand blanked, line breaks
 * kept: `#` comments, heredoc bodies, and any quoted string holding a space,
 * which is a message's prose — `"$root/docs/x.md"` holds none. A `#` opens a
 * comment only at a word's start outside quotes, so `$#` and `${#x}` stay.
 * @param {string} source
 * @param {{ keepQuoted?: boolean }} [opts]  keep a quoted string holding a
 *   space whole rather than blank it as prose
 * @returns {string}
 */
function shellOperands(source, { keepQuoted = false } = {}) {
	/** @type {ShellState} */
	const st = { heredoc: null, quote: null, quoted: "", keepQuoted };
	let out = "";
	for (const [n, line] of source.split("\n").entries()) {
		if (n > 0) {
			if (st.quote) st.quoted += "\n";
			else out += "\n";
		}
		if (st.heredoc === null) out += shellLineOperands(line, st);
		else {
			if (line.trim() === st.heredoc) st.heredoc = null;
			out += blank(line);
		}
	}
	return out + (st.quote ? blank(st.quoted) : "");
}

module.exports = { shellOperands };
