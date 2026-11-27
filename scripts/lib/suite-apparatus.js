const path = require("node:path");
const { JS_EXT_SOURCE, isTestKind } = require("./test-kind.js");

const VITEST_CONFIG = new RegExp(
	String.raw`^vitest\.(?:config|setup)${JS_EXT_SOURCE}$`,
);
const SHIPPED_DESPITE_NAME = new Set(["scripts/lib/arm-gh-stub.js"]);

/** @param {string} rel */
const isApparatus = (rel) =>
	(isTestKind(rel) || VITEST_CONFIG.test(path.basename(rel))) &&
	!SHIPPED_DESPITE_NAME.has(rel);

module.exports = { isApparatus };
