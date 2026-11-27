const path = require("node:path");

/**
 * @param {unknown} v
 * @returns {v is string}
 */
const isRepoPath = (v) =>
	typeof v === "string" &&
	v !== "" &&
	!path.isAbsolute(v) &&
	!v.split(/[\\/]/).includes("..");

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
const isRepoPathList = (v) => Array.isArray(v) && v.every(isRepoPath);

module.exports = { isRepoPath, isRepoPathList };
