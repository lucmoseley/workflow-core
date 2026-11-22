const fs = require("node:fs");
const path = require("node:path");
const { isDenyingCore } = require("./deny-capable.js");
const { clausesAdmit } = require("./if-clause.js");

const DISPATCH_ENTRY = "scripts/guard-dispatch.js";

const MANIFEST_REL = "scripts/lib/guard-cores.json";

const MANIFEST = path.join(__dirname, "guard-cores.json");

/**
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {{ name: string, core: string, tools: string,
 *   failure: "open" | "closed", tree: "session" | "host" | "both",
 *   module?: Module, host?: string,
 *   if?: string[], denyTiming?: "delayed" }} CoreRow
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
 * @param {string} [file]
 * @returns {CoreRow[]}
 */
const readManifestRows = (file = MANIFEST) =>
	Object.values(readManifest(file)).flat();

/**
 * @param {string} root
 * @returns {string}
 */
function manifestAt(root) {
	const own = path.join(root, MANIFEST_REL);
	return fs.existsSync(own) ? own : MANIFEST;
}

/**
 * @param {string} module
 */
const modulePath = (module) => path.join("scripts", "lib", module);

/**
 * @param {string} module
 * @param {string} [dir]
 */
const corePath = (module, dir = __dirname) => path.join(dir, module);

/**
 * @param {Pick<CoreRow, "tools">} row
 * @param {string | undefined} tool
 */
const isCoreFor = (row, tool) =>
	tool !== undefined && new RegExp(`^(?:${row.tools})$`).test(tool);

/**
 * @param {Record<string, unknown>} payload
 * @returns {string | undefined}
 */
const toolOf = (payload) =>
	typeof payload.tool_name === "string" ? payload.tool_name : undefined;

/**
 * @param {Pick<CoreRow, "if">} row
 * @param {Record<string, unknown>} payload
 */
function isAdmitted(row, payload) {
	if (!row.if) return true;
	const input = /** @type {Record<string, unknown> | undefined} */ (
		payload.tool_input
	);
	const command = typeof input?.command === "string" ? input.command : "";
	return clausesAdmit(row.if, toolOf(payload), command);
}

/**
 * @param {CoreRow} row
 * @param {Record<string, unknown>} payload
 * @param {{ disabled: (name: string) => boolean,
 *   moduleOn: (module: Module) => boolean }} host
 */
function isDispatchedOn(row, payload, { disabled, moduleOn }) {
	return (
		isCoreFor(row, toolOf(payload)) &&
		isAdmitted(row, payload) &&
		!disabled(row.name) &&
		!(row.module && !moduleOn(row.module))
	);
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Parameters<typeof isDispatchedOn>[2]} host
 * @returns {string[]}
 */
function denyingCoresOn(payload, host) {
	return readDispatchRows("PreToolUse")
		.filter(
			(row) =>
				isDispatchedOn(row, payload, host) && isDenyingCore(corePath(row.core)),
		)
		.map((row) => row.name);
}

/**
 * @param {string} event
 * @param {string} [file]
 * @returns {CoreRow[]}
 */
function readDispatchRows(event, file = MANIFEST) {
	return readManifest(file)[event] ?? [];
}

/**
 * @param {string} [file]
 * @returns {string[]}
 */
function readDispatchedCores(file = MANIFEST) {
	return coresOf(readManifest(file));
}

/**
 * @param {Manifest} manifest
 * @returns {string[]}
 */
function coresOf(manifest) {
	return [
		...new Set(
			Object.values(manifest)
				.flat()
				.flatMap((r) => [r.core, ...(r.host ? [r.host] : [])])
				.map(modulePath),
		),
	];
}

/**
 * @param {Manifest} manifest
 * @param {string} rel
 * @returns {string | null}
 */
function hostOf(manifest, rel) {
	const row = Object.values(manifest)
		.flat()
		.find((r) => r.host && modulePath(r.core) === rel);
	return row?.host ? modulePath(row.host) : null;
}

/**
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
	MANIFEST,
	MANIFEST_REL,
	corePath,
	coresOf,
	denyingCoresOn,
	hostOf,
	readDispatchedCores,
	expandDispatched,
	isAdmitted,
	isCoreFor,
	isDispatchedOn,
	manifestAt,
	readManifestRows,
	modulePath,
	readDispatchRows,
	readManifest,
	toolOf,
};
