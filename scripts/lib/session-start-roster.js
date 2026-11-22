const path = require("node:path");

const { readRunningHooks } = require("./core-hooks.js");
const { buildHookCommandLine, WIRED_SCRIPT_RE } = require("./rule-emission");
const { requiredGroup } = require("./regex-group.js");

/**
 * @param {string} repoRoot
 * @returns {import("./core-hooks.js").Hooks | null}
 */
function readHooksOrNull(repoRoot) {
	try {
		return readRunningHooks(repoRoot, { quiet: true });
	} catch {
		return null;
	}
}

/**
 * @param {string} repoRoot
 * @returns {boolean}
 */
function hasReadableHooks(repoRoot) {
	return readHooksOrNull(repoRoot) !== null;
}

/**
 * @param {string} line
 * @returns {string | null}
 */
function scriptsJsBasename(line) {
	for (const m of line.matchAll(WIRED_SCRIPT_RE)) {
		const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
		if (rel.startsWith("scripts/") && rel.endsWith(".js"))
			return path.basename(rel, ".js");
	}
	return null;
}

/** @type {Record<string, string>} */
const KEY_OVERRIDES = { "check-cleared-trackers": "check-cleared-trackers" };

/**
 * @param {string} repoRoot
 * @param {{ keyOverrides?: Record<string, string>, self?: string }} [opts]
 * @returns {Array<{ key: string, script: string }>}
 */
function readSessionStartRoster(
	repoRoot,
	{ keyOverrides = {}, self = "" } = {},
) {
	const matchers = readHooksOrNull(repoRoot)?.SessionStart;
	if (!Array.isArray(matchers)) return [];
	const roster = new Map();
	for (const matcher of matchers)
		for (const hook of matcher?.hooks ?? []) {
			const script = persistingScript(hook);
			if (!script) continue;
			const key = keyOverrides[script] ?? script.replace(/^check-/, "");
			if (key !== self) roster.set(key, `${script}.js`);
		}
	return [...roster].map(([key, script]) => ({ key, script }));
}

/**
 * @param {{ command?: string, args?: unknown }} hook
 * @returns {string | null}
 */
function persistingScript(hook) {
	const line = buildHookCommandLine(hook);
	if (!line.includes("WFC_NOTIFY_PERSIST=1") || !line.includes("--notify"))
		return null;
	return scriptsJsBasename(line);
}

module.exports = { readSessionStartRoster, hasReadableHooks, KEY_OVERRIDES };
