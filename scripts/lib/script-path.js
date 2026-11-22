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

/** @type {Map<string, boolean>} */
const coreRepoAnswers = new Map();

// #5581, #5584
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isCoreRepo(env = process.env) {
	if (!inCheckout(env)) return false;
	const core = coreRoot(env);
	const cwd = process.cwd();
	const key = [core, cwd, env.GIT_DIR ?? ""].join("\0");
	let answer = coreRepoAnswers.get(key);
	if (answer === undefined) {
		const own = commonDirAt(core);
		answer =
			own !== null &&
			own ===
				(env.GIT_DIR
					? commonDirOf(path.resolve(cwd, env.GIT_DIR))
					: nearestCommonDir(cwd));
		coreRepoAnswers.set(key, answer);
	}
	return answer;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function nearestCommonDir(dir) {
	for (let at = dir; ; at = path.dirname(at)) {
		const common = commonDirAt(at);
		if (common !== null || path.dirname(at) === at) return common;
	}
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function commonDirAt(dir) {
	const dotGit = path.join(dir, ".git");
	let stat;
	try {
		stat = fs.statSync(dotGit);
	} catch {
		return null;
	}
	if (stat.isDirectory()) return commonDirOf(dotGit);
	const { parseGitFileTarget } = require("./git-file.js");
	const target = parseGitFileTarget(dir, fs.readFileSync(dotGit, "utf8"));
	return target === null ? null : commonDirOf(target);
}

/**
 * @param {string} gitDir
 * @returns {string | null}
 */
function commonDirOf(gitDir) {
	const { readRegistrationCommonDir } = require("./git-file.js");
	try {
		return fs.realpathSync(readRegistrationCommonDir(gitDir) ?? gitDir);
	} catch {
		return null;
	}
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
 * @returns {string}
 */
function expandPastePaths(text, host) {
	return text.replace(/\{(?:host-root|script:([\w./-]+))\}/g, (_, name) =>
		name === undefined ? shellQuote(host) : absoluteScriptPath(name),
	);
}

const CORE_PATH = /(?<![\w./$}-])(?:\.\/)?(scripts|docs)\/([\w*.-][\w*./-]*)/g;

/**
 * @param {string} text
 * @returns {string}
 */
function resolveScriptPaths(text) {
	if (isCoreRepo()) return text;
	return text.replace(CORE_PATH, (whole, dir, rest) => {
		const name = trimEndRun(rest, ".");
		const file = `${coreRoot()}/${dir}/${name}`;
		if (!name || !fs.existsSync(file)) return whole;
		return shellQuote(file) + rest.slice(name.length);
	});
}

module.exports = {
	coreRoot,
	inCheckout,
	isCoreRepo,
	scriptPath,
	docPath,
	corePath,
	expandPastePaths,
	resolveScriptPaths,
};
