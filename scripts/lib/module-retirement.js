#!/usr/bin/env node
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
	const show = (/** @type {string} */ ref) =>
		orFallback(
			() =>
				execGit(["show", `${ref}:${CONFIG_PATH}`], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			"",
		);
	return (
		listsModule(show("HEAD"), name) === true &&
		listsModule(show(""), name) === false
	);
}

module.exports = { isModuleRetirement };

if (require.main === module)
	process.exit(isModuleRetirement(process.argv[2] ?? "") ? 0 : 1);
