/*
 * hook-code.js — the files a hook runs (#4259): every script a hook
 * registration names, the guard cores and hosts the dispatcher loads from
 * `lib/guard-cores.json`, and every file those reach by code-edges.js's
 * edges: a lib it loads and a script it spawns or runs alike, since a child
 * inherits the session's cwd. Paths are repo-relative, and only those under `scripts/`.
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
const { edgesOf } = require("./code-edges.js");
const { requiredGroup } = require("./regex-group.js");

const REGISTRATIONS = ["hooks/hooks.json", SELF_PLUGIN_HOOKS, HOST_SETTINGS];

/** A script a hook command names, however its root is spelled. */
const COMMAND_SCRIPT = /(?<![\w.-])(scripts\/[\w./-]+\.(?:[cm]?[jt]s|sh|py))/g;

/**
 * The scripts the hook registrations at `root` name.
 * @param {string} root
 * @returns {string[]}
 */
function readEntryScripts(root) {
	/** @type {string[]} */
	const out = [];
	for (const rel of REGISTRATIONS) {
		const file = path.join(root, rel);
		if (!fs.existsSync(file)) continue;
		const hooks = JSON.parse(fs.readFileSync(file, "utf8"))?.hooks ?? {};
		for (const { command } of flattenHooks(hooks))
			out.push(...parseCommandScripts(command));
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
 * Every file under `scripts/` a hook at `root` runs or loads.
 * @param {string} root
 * @returns {Set<string>} repo-relative paths
 */
function readHookCode(root) {
	const entries = readEntryScripts(root);
	if (entries.includes(DISPATCH_ENTRY))
		entries.push(...readDispatchedCores(manifestAt(root)));
	const scriptsDir = path.join(root, "scripts") + path.sep;
	/** @type {Set<string>} */
	const seen = new Set();
	const queue = entries.map((rel) => path.join(root, rel));
	while (queue.length > 0) {
		const abs = /** @type {string} */ (queue.pop());
		if (seen.has(abs) || !abs.startsWith(scriptsDir)) continue;
		let text;
		try {
			text = fs.readFileSync(abs, "utf8");
		} catch (err) {
			/* An edge names the bare join where no file resolves, and a
			 * registration may name a script this tree lacks: neither runs. */
			if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT")
				continue;
			throw err;
		}
		seen.add(abs);
		queue.push(
			...edgesOf(abs, text, () => {
				/* a foreign Python import is plugin-tree.js's fault to report */
			}),
		);
	}
	return new Set([...seen].map((abs) => path.relative(root, abs)));
}

module.exports = { readHookCode };
