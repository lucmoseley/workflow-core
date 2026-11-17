/*
 * repo-path.js — whether a config value is a repo-relative path, or a list
 * of them (#5338). The config reader and lib/hot-path-set.js both read
 * `polled` through it; the set cannot load the reader, which reaches for
 * git. lib/wfc-config.sh holds the shell half.
 *
 * A CORE: it reads nothing but its argument.
 */

const path = require("node:path");

/**
 * A non-empty relative path that does not climb out of the repo.
 * @param {unknown} v
 * @returns {v is string}
 */
const isRepoPath = (v) =>
	typeof v === "string" &&
	v !== "" &&
	!path.isAbsolute(v) &&
	!v.split(/[\\/]/).includes("..");

/**
 * An array whose every entry is a repo-relative path. One bad entry refuses
 * the whole list, so a reader never acts on part of a key it would refuse.
 * @param {unknown} v
 * @returns {v is string[]}
 */
const isRepoPathList = (v) => Array.isArray(v) && v.every(isRepoPath);

module.exports = { isRepoPath, isRepoPathList };
