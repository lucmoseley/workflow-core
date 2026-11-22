const fs = require("node:fs");
const path = require("node:path");
const { trimEndRun } = require("./trim-run.js");
const { shellQuote } = require("./sh-quote.js");
const { relativeUnder } = require("./is-under.js");

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
// The session's Bash environment lacks CLAUDE_PLUGIN_ROOT, and a local-directory marketplace points it at the source (https://github.com/anthropics/claude-code/issues/93057)
function coreRoot(env = process.env) {
	return env.WFC_SCRIPT_ROOT || path.resolve(__dirname, "..", "..");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function inCheckout(env = process.env) {
	return fs.existsSync(path.join(coreRoot(env), "package.json"));
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function scriptPath(name, env = process.env) {
	return inCheckout(env) ? `scripts/${name}` : absoluteScriptPath(name, env);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function docPath(name, env = process.env) {
	return inCheckout(env)
		? `docs/${name}`
		: absoluteCorePath(`docs/${name}`, env);
}

/**
 * @param {string} rel
 * @returns {string}
 */
function corePath(rel) {
	return (
		relativeUnder(process.cwd(), path.join(coreRoot(), rel)) ??
		absoluteCorePath(rel)
	);
}

/**
 * @param {string} rel
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function absoluteCorePath(rel, env = process.env) {
	return shellQuote(`${coreRoot(env)}/${rel}`);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function absoluteScriptPath(name, env = process.env) {
	return absoluteCorePath(`scripts/${name}`, env);
}

/**
 * @param {string} text
 * @param {string} host
 * @returns {string}
 */
function expandPastePaths(text, host) {
	return text.replace(/\{(?:host-root|script:([\w./-]+))\}/g, (_, name) =>
		name === undefined ? shellQuote(host) : absoluteScriptPath(name),
	);
}

const CORE_PATH = /(?<![\w./$}-])(?:\.\/)?(scripts|docs)\/([\w*.-][\w*./-]*)/g;

/** @type {Set<string> | null} */
let hostOwned = null;

/** @returns {Set<string>} */
function hostOwnedPaths() {
	hostOwned ??= new Set(
		fs
			.readFileSync(path.join(__dirname, "host-owned-paths.txt"), "utf8")
			.split("\n")
			.filter(Boolean),
	);
	return hostOwned;
}

/**
 * @param {string} text
 * @returns {string}
 */
function resolveScriptPaths(text) {
	if (inCheckout()) return text;
	return text.replace(CORE_PATH, (whole, dir, rest) => {
		const name = trimEndRun(rest, ".");
		const file = `${coreRoot()}/${dir}/${name}`;
		if (!name || hostOwnedPaths().has(`${dir}/${name}`) || !fs.existsSync(file))
			return whole;
		return shellQuote(file) + rest.slice(name.length);
	});
}

module.exports = {
	coreRoot,
	inCheckout,
	scriptPath,
	docPath,
	corePath,
	expandPastePaths,
	resolveScriptPaths,
	hostOwnedPaths,
};
