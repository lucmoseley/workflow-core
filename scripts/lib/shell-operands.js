const HEREDOC = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/;

/** @param {string} t */
const blank = (t) => t.replace(/[^\n]/g, " ");

/**
 * @typedef {{ heredoc: string | null, quote: string | null, quoted: string, keepQuoted: boolean }} ShellState
 */

/** @param {string} line @param {ShellState} st @returns {string} */
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
 * @param {string} line
 * @param {number} i
 * @param {ShellState} st
 * @returns {{ text: string, end: number }}
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

/** @param {ShellState} st @returns {string} */
function closeQuote(st) {
	st.quote = null;
	return !st.keepQuoted && /\s/.test(st.quoted) ? blank(st.quoted) : st.quoted;
}

/**
 * @param {string} source
 * @param {{ keepQuoted?: boolean }} [opts]
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
