/*
 * bash-quote.js — a word as bash's `printf %q` spells it, for a message that
 * prints a command line a founder may paste back into bash (#5145).
 *
 * The bash 5.2 rules, held to bash itself by bash-quote.test.ts: a word with a
 * byte the locale cannot print goes out whole in ANSI-C `$'…'`; any other word
 * has each shell metacharacter backslashed, `#` only at its start and `~` only
 * at its start or after `=` or `:`. The locale is the word's caller's, read off
 * the environment as bash reads it, since a C locale prints no byte past 0x7f.
 */

/* Backslashed wherever they stand. */
const META = new Set(" !\"$&'()*,;<>?[\\]^`{|}");

const NAMED = new Map([
	[0x07, "\\a"],
	[0x08, "\\b"],
	[0x09, "\\t"],
	[0x0a, "\\n"],
	[0x0b, "\\v"],
	[0x0c, "\\f"],
	[0x0d, "\\r"],
	[0x1b, "\\E"],
	[0x27, "\\'"],
	[0x5c, "\\\\"],
]);

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} the locale bash would run under is a UTF-8 one
 */
function utf8Locale(env) {
	const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
	return /utf-?8/i.test(locale);
}

/**
 * @param {string} word
 * @param {boolean} utf8
 * @returns {boolean} a character in `word` the locale cannot print
 */
function needsAnsiC(word, utf8) {
	for (const ch of word) {
		const c = /** @type {number} */ (ch.codePointAt(0));
		if (c < 0x20 || c === 0x7f) return true;
		if (c >= 0x80 && (!utf8 || (c >= 0x80 && c < 0xa0))) return true;
	}
	return false;
}

/**
 * @param {string} word
 * @param {boolean} utf8
 * @returns {string} `word` in `$'…'`, each unprintable byte in octal
 */
function ansiC(word, utf8) {
	let out = "";
	for (const ch of word) {
		const c = /** @type {number} */ (ch.codePointAt(0));
		const named = NAMED.get(c);
		if (named) out += named;
		else if (c >= 0x20 && c < 0x7f) out += ch;
		else if (c >= 0xa0 && utf8) out += ch;
		else
			for (const b of Buffer.from(ch, "utf8"))
				out += `\\${b.toString(8).padStart(3, "0")}`;
	}
	return `$'${out}'`;
}

/**
 * @param {string} word
 * @param {NodeJS.ProcessEnv} [env] whose locale bash would quote under
 * @returns {string} `word` as `printf %q` prints it
 */
function bashQuote(word, env = process.env) {
	if (word === "") return "''";
	const utf8 = utf8Locale(env);
	if (needsAnsiC(word, utf8)) return ansiC(word, utf8);
	let out = "";
	let prev = "";
	for (const ch of word) {
		const lead = out === "";
		if (
			META.has(ch) ||
			(ch === "#" && lead) ||
			(ch === "~" && (lead || prev === "=" || prev === ":"))
		)
			out += `\\${ch}`;
		else out += ch;
		prev = ch;
	}
	return out;
}

module.exports = { bashQuote };
