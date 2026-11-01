/*
 * suite-apparatus.js — what check-host-root.js leaves unscanned as the suite's
 * own apparatus, shared with host-root-plugin-cache.test.ts so the two never
 * disagree on which scripts the host-root rule reaches (#3743).
 *
 * Apparatus is what test-kind.js's `isTestKind` takes, and the vitest configs,
 * save `SHIPPED_DESPITE_NAME`: a file whose test-kind name belies code that
 * ships. test-kind.js's other readers keep such a file a test, which by name
 * and job it is; only the host-root rule asks whether it runs as shipped code.
 */

const path = require("node:path");
const { JS_EXT_SOURCE, isTestKind } = require("./test-kind.js");

const VITEST_CONFIG = new RegExp(
	String.raw`^vitest\.(?:config|setup)${JS_EXT_SOURCE}$`,
);
const SHIPPED_DESPITE_NAME = new Set([
	// build-arm-sandbox.js copies it into the arm sandbox as `bin/gh` (#3743).
	"scripts/lib/arm-gh-stub.js",
]);

/** @param {string} rel repo-relative, forward slashes */
const isApparatus = (rel) =>
	(isTestKind(rel) || VITEST_CONFIG.test(path.basename(rel))) &&
	!SHIPPED_DESPITE_NAME.has(rel);

module.exports = { isApparatus };
