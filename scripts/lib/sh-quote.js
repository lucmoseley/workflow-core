/*
 * sh-quote.js — a string as one sh word (#3483). Python's shlex.quote,
 * ported: a word of safe characters goes bare, so a printed command stays
 * readable, and any other is single-quoted.
 *
 * A CORE: it reads nothing but its argument.
 */

/**
 * `s` as one sh word: bare where every character is safe, single-quoted
 * otherwise, the empty string included. As with shlex.quote, a bare
 * `NAME=value` placed first in a command reads as an assignment.
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { shellQuote };
