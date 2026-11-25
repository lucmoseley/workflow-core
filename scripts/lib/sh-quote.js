/**
 * @param {string} s
 * @returns {string}
 */
function shellQuote(s) {
	return /^(?!~)(?!.*[=:]~)[\w@%+=:,./~-]+$/.test(s)
		? s
		: `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = { shellQuote };
