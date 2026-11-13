/*
 * script-path.js — the one spelling a message names a core script by (#343).
 *
 * A guard that tells a session to run `scripts/x` hands an adopter a path that
 * resolves nowhere: the core's scripts live under the plugin cache. So a
 * message names a script through scriptPath(), which answers `scripts/x` in a
 * source checkout of the core and `<plugin root>/scripts/x` in an install.
 *
 * THE ROOT IS THIS FILE'S OWN LOCATION, never CLAUDE_PLUGIN_ROOT: the session's
 * Bash environment lacks the variable, so a CLI such as rule-text.sh run from a
 * skill would go unresolved, and a local-directory marketplace points it at the
 * source rather than the install (anthropics/claude-code#93057). A checkout is
 * told from an install by `package.json`, which plugin-tree.js never ships —
 * so a copy of scripts/ under some other tree with a package.json reads as a
 * checkout and answers bare.
 *
 * A doc the plugin ships is named the same way, through docPath() (#1010,
 * #1452).
 *
 * WFC_SCRIPT_ROOT stands in for the location: in tests, and for a baseline
 * checker lib/check.js runs from a partial tree (#5178).
 *
 * scripts/lib/script-path.sh is the bash twin; keep the two in step.
 * expandPastePaths() is expand_paste_paths there, docPath() doc_path.
 * corePath() has no twin until a shell message names a file outside scripts/
 * and docs/ (#2234).
 */

const fs = require("node:fs");
const path = require("node:path");
const { trimEndRun } = require("./trim-run.js");
const { shellQuote } = require("./sh-quote.js");
const { relativeUnder } = require("./is-under.js");

/**
 * @param {NodeJS.ProcessEnv} [env] the environment the message is built under
 * @returns {string} absolute path of the core root the running code sits in
 */
function coreRoot(env = process.env) {
	return env.WFC_SCRIPT_ROOT || path.resolve(__dirname, "..", "..");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} the core runs from a source checkout rather than an install
 */
function inCheckout(env = process.env) {
	return fs.existsSync(path.join(coreRoot(env), "package.json"));
}

/**
 * @param {string} name a path under scripts/, e.g. `session-arbiter.js`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} how a session should spell it on a command line
 */
function scriptPath(name, env = process.env) {
	return inCheckout(env) ? `scripts/${name}` : absoluteScriptPath(name, env);
}

/**
 * A doc the release does not ship spells an install path that does not exist.
 * @param {string} name a path under docs/, e.g. `agents/issue-tracker.md`
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} how a session should spell it to read it
 */
function docPath(name, env = process.env) {
	return inCheckout(env)
		? `docs/${name}`
		: absoluteCorePath(`docs/${name}`, env);
}

/**
 * Any file the core ships, such as a skill's own script, spelled relative only
 * where the cwd is the core root: unlike scriptPath(), a source checkout run
 * against another repo answers absolute too (#2234).
 * @param {string} rel a path from the core root, e.g.
 *   `.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js`
 * @returns {string} how a session should spell it on a command line
 */
function corePath(rel) {
	return (
		relativeUnder(process.cwd(), path.join(coreRoot(), rel)) ??
		absoluteCorePath(rel)
	);
}

/**
 * @param {string} rel a path from the core root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} its absolute spelling, checkout or install
 */
function absoluteCorePath(rel, env = process.env) {
	/* Concatenated, never path.join: the bash twin cannot normalise `..`. */
	return shellQuote(`${coreRoot(env)}/${rel}`);
}

/**
 * @param {string} name a path under scripts/
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} the script's absolute spelling, checkout or install
 */
function absoluteScriptPath(name, env = process.env) {
	return absoluteCorePath(`scripts/${name}`, env);
}

/**
 * `text` with `{host-root}` and `{script:x}` spelt absolute, for a line the
 * founder pastes into a terminal that may open anywhere (#643). One pass, so a
 * placeholder inside a root it expands to is never expanded again (#2613).
 * @param {string} text
 * @param {string} host the host repository's root
 * @returns {string}
 */
function expandPastePaths(text, host) {
	/* A replacer, never a string: a `$` in a path is not a replacement pattern. */
	return text.replace(/\{(?:host-root|script:([\w./-]+))\}/g, (_, name) =>
		name === undefined ? shellQuote(host) : absoluteScriptPath(name),
	);
}

/**
 * A left edge nothing could make the tail of a longer path — plugin-tree.js's
 * EDGE.
 */
const CORE_PATH = /(?<![\w./$}-])(?:\.\/)?(scripts|docs)\/([\w*.-][\w*./-]*)/g;

/**
 * `text` with every `scripts/x` and `docs/x` naming a file the core holds
 * spelled at the plugin root in an install (#1452). A name the core lacks — an
 * adopter's own script, a doc the host owns, a glob — stays as written, and so does a sentence's
 * closing full stop.
 * @param {string} text
 * @returns {string}
 */
function resolveScriptPaths(text) {
	if (inCheckout()) return text;
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
	scriptPath,
	docPath,
	corePath,
	expandPastePaths,
	resolveScriptPaths,
};
