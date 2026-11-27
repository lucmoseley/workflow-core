const STAMP_PATHS = ["docs/doc-map.md", "CLAUDE.md"];

/** @param {string[]} paths @param {string[]} [stamps] */
const withoutStamps = (paths, stamps = STAMP_PATHS) =>
	paths.filter((p) => !stamps.includes(p));

module.exports = { STAMP_PATHS, withoutStamps };
