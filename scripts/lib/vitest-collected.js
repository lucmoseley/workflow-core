const fs = require("node:fs");
const path = require("node:path");
const { JS_TEST_FILE } = require("./test-kind.js");
const { caught } = require("./caught.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

// workflow-core#2960 guess
const LIST_TIMEOUT_MS = 120_000;

/**
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
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: CHILD_MAX_BUFFER,
			timeout: LIST_TIMEOUT_MS,
		});
	} catch (error) {
		if (caught(error).code === "ETIMEDOUT")
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

const VITEST_CONFIG = /^(?:vitest|vite)\.config\.[cm]?[jt]s$/;

/**
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
