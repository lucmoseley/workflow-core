/*
 * kit-context.js — the KitContext a Node guard's core is handed, and the
 * adapters one call shares (#2784, ADR-0010). lib/guard-entry.js's `run`,
 * lib/guard-dispatch.js and lib/suite-concurrency-host.js's readGate all
 * build from it.
 *
 * NOTHING HERE REACHES lib/entry-input.js, the entry's fail-open logger: a
 * launcher that builds a context from this file stays out of
 * check-guard-test-isolation.js's logging guards (#3137).
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");
const { moduleReader } = require("./workflow-core-config.js");
const { segment } = require("./review-suffix.js");

/**
 * @typedef {import("./workflow-core-config.js").Module} Module
 * @typedef {import("./shell-parse.js").WalkPorts & {
 *   moduleOn: (module: Module) => boolean,
 *   treeClass: (dir: string) => "shared" | "linked" | "other" | "unknown",
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
 * }} KitContext the walks' ports, so a core hands them straight to
 *   walkCommands and walkGit; the module gate, which reads a config fault as
 *   off and never throws; whether a rule is told; and a read of a
 *   latch of the guard's own, null where it is absent or has no key; the
 *   payload's `tool_input`, `tool_name` and `tool_response`, undefined where
 *   it carries none; agentKey's answer for it; its `agent_id`, which the
 *   harness sets only on a call from inside a subagent, "" where it is absent;
 *   `main` or `a<agent_id>`; its `permission_mode`; a rule's fragment,
 *   throwing where the store cannot give it; and lib/script-path.js's
 *   spellings of a core path as an install reaches it: every one in `text`,
 *   a script's, a doc's
 * @typedef {{ root: string, payload: Record<string, unknown>,
 *   log: (what: string, detail?: string) => void }} PortEnv
 */

/** @param {string} id */
const bare = (id) => (id.startsWith("rule:") ? id.slice(5) : id);

/**
 * The payload's `agent_id` as text, "" where it is absent, null or empty. Any
 * other value names a subagent: misreading one
 * as the main session would refuse a sanctioned subagent call.
 * @param {Record<string, unknown>} payload
 */
const agentId = (payload) =>
	payload.agent_id === undefined || payload.agent_id === null
		? ""
		: String(payload.agent_id);

/**
 * `main` or `a<agent_id>`, and the session id, both made path
 * segments. Null where the payload carries no session id.
 * @param {Record<string, unknown>} payload
 */
function agentKey(payload) {
	const sid = typeof payload.session_id === "string" ? payload.session_id : "";
	if (!sid) return null;
	const id = agentId(payload);
	const agent = id ? `a${segment(id)}` : "main";
	return { agent, sid: segment(sid) };
}

/**
 * A rule's latch: one file per (id, agent, session). The id keeps its dot,
 * the namespaces' (`warn.`, `sum.`) separator.
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

/**
 * The tree reader a git walk judges each tree with, built on first use: a
 * command naming no git subcommand a walk asks for pays no git call.
 * @param {string} root
 */
function lazyTreeClass(root) {
	/** @type {((dir: string) => "shared" | "linked" | "other" | "unknown") | undefined} */
	let classify;
	return (/** @type {string} */ dir) => {
		classify ??= require("./git-tree.js").treeClassifier(root);
		return classify(dir);
	};
}

/**
 * The expansion scope a core resolves `$NAME` against: the environment, plus
 * the two ids bash sets itself and never exports.
 * @returns {Record<string, string>}
 */
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
 * The adapters one call builds once, however many cores read them.
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
		tool: typeof payload.tool_name === "string" ? payload.tool_name : undefined,
		response: payload.tool_response,
		key,
		agent: agentId(payload),
		agentLabel: agentId(payload) ? `a${segment(agentId(payload))}` : "main",
		permissionMode:
			typeof payload.permission_mode === "string"
				? payload.permission_mode
				: undefined,
		cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
		fallbackCwd: process.cwd(),
		vars: shellVars(),
		isDir: (p) =>
			fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false,
		/* Loaded on a hit only: it is most of a silent call's cost (#2799). */
		ruleText: (id) => require("./rule-text.js").readRuleText(id, root),
		corePaths: (text) => require("./script-path.js").resolveScriptPaths(text),
		scriptPath: (name) => require("./script-path.js").scriptPath(name),
		docPath: (name) => require("./script-path.js").docPath(name),
		...readers,
		log,
		/* Fails towards telling: no key is not told, logged. */
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
			try {
				return fs.readFileSync(p, "utf8");
			} catch {
				return null;
			}
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
