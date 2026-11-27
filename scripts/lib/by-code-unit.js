/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byCodeUnit(a, b) {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

module.exports = { byCodeUnit };
