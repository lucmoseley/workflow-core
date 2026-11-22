const { configDirs } = require("./arbiter-store");

/**
 * @param {string[] | undefined} given
 * @returns {string[]}
 */
function seatsFrom(given) {
	const seats = given?.filter(Boolean) ?? [];
	return seats.length > 0 ? seats : configDirs();
}

module.exports = { seatsFrom };
