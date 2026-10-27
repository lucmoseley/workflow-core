/*
 * script-path.js — the one spelling a message names a core script by (workflow-core#343).
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
 * A doc the plugin ships is named the same way, through docPath() (workflow-core#1010,
 * workflow-core#1452).
 *
 * WFC_SCRIPT_ROOT stands in for the location, for tests only.
 *
 * scripts/lib/script-path.sh is the bash twin; keep the two in step.
 * expandPastePaths() is expand_paste_paths there, docPath() doc_path.
 * corePath() has no twin until a shell message names a file outside scripts/
 * and docs/ (workflow-core#2234).
 */

const fs = require("node:fs");
const path = require("node:path");

/** @returns {string} absolute path of the core root the running code sits in */
function coreRoot() {
	return process.env.WFC_SCRIPT_ROOT || path.resolve(__dirname, "..", "..");
}

/** @returns {boolean} the core runs from a source checkout rather than an install */
function inCheckout() {
	return fs.existsSync(path.join(coreRoot(), "package.json"));
}

/**
 * A path quoted for a shell only where it needs it, so the common case stays
 * readable.
 * @param {string} p
 * @returns {string}
 */
function shellWord(p) {
	return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;
}

/**
 * @param {string} name a path under scripts/, e.g. `session-arbiter.js`
 * @returns {string} how a session should spell it on a command line
 */
function scriptPath(name) {
	return inCheckout() ? `scripts/${name}` : absoluteScriptPath(name);
}

/**
 * A doc the release does not ship spells an install path that does not exist.
 * @param {string} name a path under docs/, e.g. `agents/issue-tracker.md`
 * @returns {string} how a session should spell it to read it
 */
function docPath(name) {
	return inCheckout() ? `docs/${name}` : absoluteCorePath(`docs/${name}`);
}

/**
 * Any file the core ships, such as a skill's own script, spelled relative only
 * where the cwd is the core root: unlike scriptPath(), a source checkout run
 * against another repo answers absolute too (workflow-core#2234).
 * @param {string} rel a path from the core root, e.g.
 *   `.claude/skills/roadmap-edit/scripts/gen-roadmap-digest.js`
 * @returns {string} how a session should spell it on a command line
 */
function corePath(rel) {
	const fromCwd = path.relative(process.cwd(), path.join(coreRoot(), rel));
	return fromCwd.startsWith("..") || path.isAbsolute(fromCwd)
		? absoluteCorePath(rel)
		: fromCwd;
}

/**
 * @param {string} rel a path from the core root
 * @returns {string} its absolute spelling, checkout or install
 */
function absoluteCorePath(rel) {
	/* Concatenated, never path.join: the bash twin cannot normalise `..`. */
	return shellWord(`${coreRoot()}/${rel}`);
}

/**
 * @param {string} name a path under scripts/
 * @returns {string} the script's absolute spelling, checkout or install
 */
function absoluteScriptPath(name) {
	return absoluteCorePath(`scripts/${name}`);
}

/**
 * `text` with `{host-root}` and `{script:x}` spelt absolute, for a line the
 * founder pastes into a terminal that may open anywhere (workflow-core#643). One pass, so a
 * placeholder inside a root it expands to is never expanded again (workflow-core#2613).
 * @param {string} text
 * @param {string} host the host repository's root
 * @returns {string}
 */
function expandPastePaths(text, host) {
	/* A replacer, never a string: a `$` in a path is not a replacement pattern. */
	return text.replace(/\{(?:host-root|script:([\w./-]+))\}/g, (_, name) =>
		name === undefined ? shellWord(host) : absoluteScriptPath(name),
	);
}

/**
 * A left edge nothing could make the tail of a longer path — plugin-tree.js's
 * EDGE.
 */
const CORE_PATH = /(?<![\w./$}-])(?:\.\/)?(scripts|docs)\/([\w*.-][\w*./-]*)/g;

/**
 * `text` with every `scripts/x` and `docs/x` naming a file the core holds
 * spelled at the plugin root in an install (workflow-core#1452). A name the core lacks — an
 * adopter's own script, a doc the host owns, a glob — stays as written, and so does a sentence's
 * closing full stop.
 * @param {string} text
 * @returns {string}
 */
function resolveScriptPaths(text) {
	if (inCheckout()) return text;
	return text.replace(CORE_PATH, (whole, dir, rest) => {
		const name = rest.replace(/\.+$/, "");
		const file = `${coreRoot()}/${dir}/${name}`;
		if (!name || !fs.existsSync(file)) return whole;
		return shellWord(file) + rest.slice(name.length);
	});
}

module.exports = {
	coreRoot,
	inCheckout,
	shellWord,
	scriptPath,
	docPath,
	corePath,
	expandPastePaths,
	resolveScriptPaths,
};
