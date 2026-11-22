const fs = require("node:fs");
const path = require("node:path");
const {
	flattenHooks,
	HOST_SETTINGS,
	SELF_PLUGIN_HOOKS,
} = require("./core-hooks.js");
const {
	DISPATCH_ENTRY,
	manifestAt,
	readDispatchedCores,
} = require("./guard-cores.js");
const { readRunReach } = require("./code-edges.js");
const { noop } = require("./noop.js");
const { requiredGroup } = require("./regex-group.js");

const REGISTRATIONS = ["hooks/hooks.json", SELF_PLUGIN_HOOKS, HOST_SETTINGS];

const COMMAND_SCRIPT = /(?<![\w.-])(scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh|py))/g;

/**
 * @param {string} root
 * @param {string} [event]
 * @returns {string[]}
 */
function readEntryScripts(root, event) {
	/** @type {string[]} */
	const out = [];
	for (const rel of REGISTRATIONS) {
		const file = path.join(root, rel);
		if (!fs.existsSync(file)) continue;
		const hooks = JSON.parse(fs.readFileSync(file, "utf8"))?.hooks ?? {};
		for (const hook of flattenHooks(hooks))
			if (event === undefined || hook.event === event)
				out.push(...parseCommandScripts(hook.command));
	}
	return out;
}

/**
 * @param {unknown} command
 * @returns {string[]}
 */
const parseCommandScripts = (command) =>
	typeof command === "string"
		? [...command.matchAll(COMMAND_SCRIPT)].map((m) =>
				requiredGroup(m, 1, COMMAND_SCRIPT),
			)
		: [];

/**
 * @param {string} root
 * @param {string} [event]
 * @returns {Set<string>}
 */
function readHookCode(root, event) {
	const entries = readEntryScripts(root, event);
	if (entries.includes(DISPATCH_ENTRY))
		entries.push(...readDispatchedCores(manifestAt(root)));
	const runReach = readRunReach(root);
	/** @type {Set<string>} */
	const code = new Set();
	for (const entry of entries)
		for (const rel of runReach(entry, noop).files)
			if (rel.startsWith("scripts/")) code.add(rel);
	return code;
}

module.exports = { readHookCode };
