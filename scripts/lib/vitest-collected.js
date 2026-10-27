/*
 * vitest-collected.js — which test files vitest collects in a tree: the one
 * answer the touched-test route, a run's admission weight and the suite-size
 * check share (#2960), taken from vitest's own listing so a config's include
 * or exclude is never restated by hand.
 */

const fs = require("node:fs");
const path = require("node:path");
const { JS_TEST_FILE } = require("./test-kind.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/* A ceiling on a vitest listing, so a wedged vitest throws to its caller
 * rather than hanging it. Not measured against a slow machine. */
const LIST_TIMEOUT_MS = 120_000;

/**
 * The test files `vitest list <args>` names, repo-relative.
 *
 * @param {string} bin
 * @param {string} root
 * @param {ExecFn} execFn
 * @param {string[]} args
 * @returns {string[]}
 */
function vitestList(bin, root, execFn, args) {
	let out;
	try {
		out = execFn(bin, ["list", ...args], {
			cwd: root,
			encoding: "utf8",
			/* stderr piped, so a failure's error carries vitest's own text. */
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: CHILD_MAX_BUFFER,
			timeout: LIST_TIMEOUT_MS,
		});
	} catch (error) {
		if (/** @type {{ code?: string }} */ (error)?.code === "ETIMEDOUT")
			throw new Error(
				`vitest list timed out after ${LIST_TIMEOUT_MS / 1000} s`,
				{ cause: error },
			);
		throw error;
	}
	return String(out ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => JS_TEST_FILE.test(line))
		.map((line) => path.relative(root, path.resolve(root, line)));
}

/**
 * The configs vitest discovers at the root, any of which can narrow what it
 * collects. One named only by `--config` on the command line is not seen.
 */
const VITEST_CONFIG = /^(?:vitest|vite)\.config\.[cm]?[jt]s$/;

/**
 * Of `files`, the test files vitest collects in the tree at `root`. Without a
 * config its default include is `JS_TEST_FILE`.
 *
 * @param {string} root
 * @param {string[]} paths
 * @param {ExecFn} execFn
 * @returns {string[]}
 */
function readVitestCollected(root, paths, execFn) {
	const files = paths.filter((p) => JS_TEST_FILE.test(p));
	if (
		files.length === 0 ||
		!fs.readdirSync(root).some((name) => VITEST_CONFIG.test(name))
	)
		return files;
	const bin = path.join(root, "node_modules", ".bin", "vitest");
	const listed = new Set(
		vitestList(bin, root, execFn, ["--filesOnly", ...files]),
	);
	return files.filter((f) => listed.has(f));
}

module.exports = { readVitestCollected, vitestList };
