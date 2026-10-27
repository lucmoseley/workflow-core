/*
 * guard-cores.js — lib/guard-cores.json read without loading a core (#2786):
 * the rows guard-dispatch.js runs, and the static readers' view of one
 * dispatcher registration as the cores it runs. The guard dispatcher, not
 * subagent dispatch (lib/dispatch-*.js).
 *
 * A reader that keys on one script per hook line — the rule-byte figures, the
 * guard registry, the fire needles — would read the dispatcher as one guard
 * on its entry's union matcher, pricing every core's rules against every tool
 * in it. expandDispatched hands such a reader one registration per core, on
 * the core's own tools, its command the core's module.
 */

const fs = require("node:fs");
const path = require("node:path");

const DISPATCH_ENTRY = "scripts/guard-dispatch.js";

const MANIFEST_REL = "scripts/lib/guard-cores.json";

const MANIFEST = path.join(__dirname, "guard-cores.json");

/**
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {{ name: string, core: string, tools: string,
 *   failure: "open" | "closed", module?: Module, host?: string }} CoreRow
 * @typedef {Record<string, CoreRow[]>} Manifest
 */

/**
 * @param {string} [file]
 * @returns {Manifest}
 */
function readManifest(file = MANIFEST) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * The manifest a tree rooted at `root` dispatches from: its own where it ships
 * one, so a materialised revision is read as committed rather than as the
 * live tree holds it (#2924); else this plugin's, as in an adopting host.
 * @param {string} root
 * @returns {string}
 */
function manifestAt(root) {
	const own = path.join(root, MANIFEST_REL);
	return fs.existsSync(own) ? own : MANIFEST;
}

/**
 * A row's module as a path from the repo root.
 * @param {string} module a file under scripts/lib
 */
const modulePath = (module) => path.join("scripts", "lib", module);

/**
 * A row's module or host as an absolute path, for a require.
 * @param {string} module a file under scripts/lib
 */
const corePath = (module) => path.join(__dirname, module);

/**
 * Whether `row`'s core judges a call of `tool`: its `tools` matched whole.
 * @param {Pick<CoreRow, "tools">} row
 * @param {string | undefined} tool
 */
const isCoreFor = (row, tool) =>
	tool !== undefined && new RegExp(`^(?:${row.tools})$`).test(tool);

/**
 * @param {string} event
 * @returns {CoreRow[]}
 */
function dispatchRows(event) {
	return readManifest()[event] ?? [];
}

/**
 * Every core and host module the dispatcher can load, on any event, as a path
 * from the repo root: what the kit loads that no `require` names.
 * @param {string} [file]
 * @returns {string[]}
 */
function readDispatchedCores(file = MANIFEST) {
	return [
		...new Set(
			Object.values(readManifest(file))
				.flat()
				.flatMap((r) => [r.core, ...(r.host ? [r.host] : [])])
				.map(modulePath),
		),
	];
}

/**
 * `regs` with each registration that runs the dispatcher replaced by one per
 * core of `event`: matcher the core's tools, command line its module's path.
 * @template {{ matcher?: string, commandLine: string }} R
 * @param {string} event
 * @param {R[]} regs
 * @param {Manifest} [manifest]
 * @returns {(R & { core?: string })[]}
 */
function expandDispatched(event, regs, manifest = readManifest()) {
	return regs.flatMap((reg) =>
		reg.commandLine.includes(DISPATCH_ENTRY)
			? (manifest[event] ?? []).map((row) => ({
					...reg,
					matcher: row.tools,
					commandLine: modulePath(row.core),
					core: row.name,
				}))
			: [reg],
	);
}

module.exports = {
	DISPATCH_ENTRY,
	MANIFEST_REL,
	corePath,
	dispatchRows,
	readDispatchedCores,
	expandDispatched,
	isCoreFor,
	manifestAt,
	readManifest,
};
