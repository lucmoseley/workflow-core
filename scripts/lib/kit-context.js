const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const { toolOf } = require("./guard-cores.js");
const { sessionDir } = require("./host-root.js");
const { markersDir } = require("./marker-root.js");
const { moduleReader } = require("./workflow-core-config.js");
const { segment } = require("./review-suffix.js");

/**
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {import("./shell-parse.js").WalkPorts & {
 *   moduleOn: (module: Module) => boolean,
 *   treeClass: (dir: string) => "shared" | "linked" | "other" | "unknown",
 *   statKind: (p: string) => StatKind,
 *   log: (what: string, detail?: string) => void,
 *   told: (id: string) => boolean,
 *   readLatch: (name: string) => string | null,
 *   input: Record<string, unknown>,
 *   tool: string | undefined,
 *   response: unknown,
 *   key: { agent: string, sid: string } | null,
 *   agent: string,
 *   agentLabel: string,
 *   permissionMode: string | undefined,
 *   ruleText: (id: string) => string,
 *   corePaths: (text: string) => string,
 *   scriptPath: (name: string) => string,
 *   docPath: (name: string) => string,
 * }} KitContext
 * @typedef {"file" | "dir" | "other" | "absent" | "unreadable"} StatKind
 * @typedef {{ root: string, payload: Record<string, unknown>,
 *   log: (what: string, detail?: string) => void }} PortEnv
 */

/** @param {string} id */
const bare = (id) => (id.startsWith("rule:") ? id.slice(5) : id);

/** @param {Record<string, unknown>} payload */
const agentId = (payload) =>
	payload.agent_id === undefined || payload.agent_id === null
		? ""
		: String(payload.agent_id);

/** @param {Record<string, unknown>} payload */
function agentKey(payload) {
	const sid = typeof payload.session_id === "string" ? payload.session_id : "";
	if (!sid) return null;
	const id = agentId(payload);
	const agent = id ? `a${segment(id)}` : "main";
	return { agent, sid: segment(sid) };
}

/**
 * @param {string} root
 * @param {string} id
 * @param {{ agent: string, sid: string }} key
 */
const latchPath = (root, id, key) =>
	path.join(
		markersDir(root),
		`.rule-injected-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}-${key.agent}-${key.sid}`,
	);

/** @param {string} id */
const warnId = (id) => `warn.${bare(id)}`;

/** @param {string} root */
function lazyTreeClass(root) {
	/** @type {((dir: string) => "shared" | "linked" | "other" | "unknown") | undefined} */
	let classify;
	return (/** @type {string} */ dir) => {
		classify ??= require("./git-tree.js").treeClassifier(root);
		return classify(dir);
	};
}

/**
 * @param {string} p
 * @returns {StatKind}
 */
function statKind(p) {
	try {
		const st = fs.statSync(p);
		if (st.isDirectory()) return "dir";
		return st.isFile() ? "file" : "other";
	} catch (err) {
		return caught(err).code === "ENOENT" ? "absent" : "unreadable";
	}
}

/** @returns {Record<string, string>} */
function shellVars() {
	/** @type {Record<string, string>} */
	const vars = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined) vars[k] = v;
	if (typeof process.getuid === "function") vars.UID = String(process.getuid());
	if (typeof process.geteuid === "function")
		vars.EUID = String(process.geteuid());
	return vars;
}

/**
 * @param {string} root
 * @param {(what: string, detail?: string) => void} log
 * @returns {Pick<KitContext, "moduleOn" | "treeClass">}
 */
const sharedReaders = (root, log) => ({
	moduleOn: moduleReader(root, log),
	treeClass: lazyTreeClass(root),
});

/**
 * @template {Pick<KitContext, "moduleOn" | "treeClass">} R
 * @param {PortEnv} env
 * @param {R} readers
 * @returns {KitContext & R}
 */
function kitContext({ root, payload, log }, readers) {
	const key = agentKey(payload);
	/** @param {string} name */
	const latch = (name) => (key ? latchPath(root, name, key) : null);
	const input = payload.tool_input;
	return {
		input:
			input && typeof input === "object"
				? /** @type {Record<string, unknown>} */ (input)
				: {},
		tool: toolOf(payload),
		response: payload.tool_response,
		key,
		agent: agentId(payload),
		agentLabel: agentId(payload) ? `a${segment(agentId(payload))}` : "main",
		permissionMode:
			typeof payload.permission_mode === "string"
				? payload.permission_mode
				: undefined,
		cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
		fallbackCwd: sessionDir(payload),
		vars: shellVars(),
		isDir: (p) =>
			fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
		statKind,
		// #2799
		ruleText: (id) => require("./rule-text.js").readRuleText(id, root),
		corePaths: (text) => require("./script-path.js").resolveScriptPaths(text),
		scriptPath: (name) => require("./script-path.js").scriptPath(name),
		docPath: (name) => require("./script-path.js").docPath(name),
		...readers,
		log,
		told: (id) => {
			const p = latch(warnId(id));
			if (p === null) {
				log(`no session key — rule ${id} unlatchable, delivered again`);
				return false;
			}
			return fs.existsSync(p);
		},
		readLatch: (name) => {
			const p = latch(name);
			if (p === null) return null;
			const got = readText(p);
			if (got.state === "read") return got.data;
			if (got.state === "unreadable")
				log(`latch ${name} unreadable — read as unwritten`, got.message);
			return null;
		},
	};
}

module.exports = {
	agentKey,
	bare,
	kitContext,
	latchPath,
	sharedReaders,
	warnId,
};
