const fs = require("node:fs");
const path = require("node:path");
const { trimEndRun } = require("./trim-run.js");
const { shellQuote } = require("./sh-quote.js");
const { relativeUnder } = require("./is-under.js");
const { orFallback } = require("./caught.js");

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
function coreIsCheckout(env = process.env) {
	return fs.existsSync(path.join(coreRoot(env), "package.json"));
}

/** @type {Map<string, boolean>} */
const coreRepoAnswers = new Map();

// #5581, #5584
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isCoreRepo(env = process.env) {
	if (!coreIsCheckout(env)) return false;
	const core = coreRoot(env);
	const cwd = process.cwd();
	const key = [core, cwd, env.GIT_DIR ?? ""].join("\0");
	let answer = coreRepoAnswers.get(key);
	if (answer === undefined) {
		answer = orFallback(() => readSharesCoreRepo(core, cwd, env), false);
		coreRepoAnswers.set(key, answer);
	}
	return answer;
}

/**
 * @param {string} core
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean}
 */
function readSharesCoreRepo(core, cwd, env) {
	const { readGitDirCommonDir, readRepoCommonDir } = require("./git-file.js");
	const own = readRepoCommonDir(core);
	if (own?.top !== core || !own.common) return false;
	const here = env.GIT_DIR
		? readGitDirCommonDir(path.resolve(cwd, env.GIT_DIR))
		: readRepoCommonDir(cwd)?.common;
	return !!here && fs.realpathSync(here) === fs.realpathSync(own.common);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function scriptPath(name, env = process.env) {
	return isCoreRepo(env) ? `scripts/${name}` : absoluteScriptPath(name, env);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function docPath(name, env = process.env) {
	return isCoreRepo(env)
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function expandPastePaths(text, host, env = process.env) {
	return text.replace(/\{(?:host-root|script:([\w./-]+))\}/g, (_, name) =>
		name === undefined ? shellQuote(host) : absoluteScriptPath(name, env),
	);
}

const CORE_PATH = /(?<![\w./$}-])(?:\.\/)?(scripts|docs)\/([\w*.-][\w*./-]*)/g;

/** @type {Set<string> | null} */
let hostOwned = null;

/** @returns {Set<string>} */
function readHostOwnedPaths() {
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
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveScriptPaths(text, env = process.env) {
	if (isCoreRepo(env)) return text;
	return text.replace(CORE_PATH, (whole, dir, rest) => {
		const name = trimEndRun(rest, ".");
		const file = `${coreRoot(env)}/${dir}/${name}`;
		if (
			!name ||
			readHostOwnedPaths().has(`${dir}/${name}`) ||
			!fs.existsSync(file)
		)
			return whole;
		return shellQuote(file) + rest.slice(name.length);
	});
}

module.exports = {
	coreRoot,
	coreIsCheckout,
	isCoreRepo,
	scriptPath,
	docPath,
	corePath,
	expandPastePaths,
	resolveScriptPaths,
};
