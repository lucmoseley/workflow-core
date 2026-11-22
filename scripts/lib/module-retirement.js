#!/usr/bin/env node
const { parseArgs } = require("node:util");
const { CONFIG_PATH } = require("./workflow-core-config.js");
const { orFallback } = require("./caught.js");
const { execGit } = require("./git.js");

/**
 * @param {string} text
 * @param {string} name
 * @returns {boolean | null}
 */
function listsModule(text, name) {
	const modules = orFallback(() => JSON.parse(text).modules, null);
	return Array.isArray(modules) ? modules.includes(name) : null;
}

/**
 * #5405
 *
 * @param {string} name
 * @returns {boolean}
 */
function isModuleRetirement(name) {
	const show = (/** @type {string} */ spec) =>
		orFallback(
			() =>
				execGit(["show", spec], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			"",
		);
	return (
		listsModule(show(`HEAD:${CONFIG_PATH}`), name) === true &&
		listsModule(show(`:${CONFIG_PATH}`), name) === false
	);
}

module.exports = { isModuleRetirement };

if (require.main === module) {
	const { positionals } = parseArgs({ allowPositionals: true, strict: true });
	const [name] = positionals;
	process.exit(
		positionals.length === 1 && name !== undefined && isModuleRetirement(name)
			? 0
			: 1,
	);
}
