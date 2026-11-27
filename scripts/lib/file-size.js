const fs = require("node:fs");

/**
 * @param {string} file
 * @returns {number | null}
 */
const readSize = (file) =>
	fs.existsSync(file) ? fs.statSync(file).size : null;

module.exports = { readSize };
