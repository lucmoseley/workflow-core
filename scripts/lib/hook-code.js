/*
 * hook-code.js — the files a hook runs (#4259): every script a hook
 * registration names, the guard cores and hosts the dispatcher loads from
 * `lib/guard-cores.json`, and every file each one's run reaches
 * (code-edges.js's `readRunReach`): a lib it loads and a script it spawns or
 * runs alike, since a child inherits the session's cwd. Paths are
 * repo-relative, and only those under `scripts/`.
 *
 * The registrations read are the plugin's `hooks/hooks.json`, the
 * self-plugin's and `.claude/settings.json`, each where present at the root.
 * Residual: a file loaded through a path built at run time, which no edge
 * reads, is left out.
 */

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
const { requiredGroup } = require("./regex-group.js");

const REGISTRATIONS = ["hooks/hooks.json", SELF_PLUGIN_HOOKS, HOST_SETTINGS];

/** A script a hook command names, however its root is spelled. */
const COMMAND_SCRIPT = /(?<![\w.-])(scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh|py))/g;

/**
 * The scripts the hook registrations at `root` name, for `event` alone
 * where one is given.
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
 * The scripts one hook command names.
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
 * Every file under `scripts/` a hook at `root` runs or loads, of `event`'s
 * hooks alone where one is given, as the session-start test's: the scope is
 * this filter over each entry's whole run, which may pass through a file
 * outside `scripts/`. A path no file stands at, as a registration naming a
 * script this tree lacks, runs nothing.
 * @param {string} root
 * @param {string} [event]
 * @returns {Set<string>} repo-relative paths
 */
function readHookCode(root, event) {
	const entries = readEntryScripts(root, event);
	if (entries.includes(DISPATCH_ENTRY))
		entries.push(...readDispatchedCores(manifestAt(root)));
	const runReach = readRunReach(root);
	/** @type {Set<string>} */
	const code = new Set();
	const noFault = () => {
		/* a foreign Python import is plugin-tree.js's fault to report */
	};
	for (const entry of entries)
		for (const rel of runReach(entry, noFault).files)
			if (rel.startsWith("scripts/")) code.add(rel);
	return code;
}

module.exports = { readHookCode };
