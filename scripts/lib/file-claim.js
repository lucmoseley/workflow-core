const { caught } = require("./caught.js");
const { throwUnreadable } = require("./file-read.js");
const { ruleModule } = require("./rule-gates.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { treeOrHost } = require("./tree-or.js");
const { isScratch } = require("./scratch-dir.js");
const { relativeUnder } = require("./is-under.js");

// guess, #5529
const ANCHOR_MAX = 8000;

// guess, #5529
const NEW_IDS_MAX = 64;

const CLASSES = "docs/doc-map-classes.json";

/**
 * @typedef {{ ok: true, stdout: string } | { ok: false, why: string,
 *   stdout: string }} ArbiterAnswer
 * @typedef {import("./core-contract.js").CoreContext & {
 *   arbiterCheck: (args: string[], cwd: string) => ArbiterAnswer,
 * }} FileClaimContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

/** @param {string} text */
const entryIds = (text) =>
	text.split("\n").flatMap((line) => {
		const m = /^### (B[0-9]+)/.exec(line);
		return m ? [m[1]] : [];
	});

/**
 * @param {string} file
 * @param {FileClaimContext} ctx
 */
function editFields(file, ctx) {
	const { old_string: old, new_string: neu } = ctx.input;
	let anchor = "";
	let anchorLen = "0";
	if (typeof old === "string") {
		anchor = old.slice(0, ANCHOR_MAX);
		anchorLen = String(old.length);
	} else if (old != null) {
		anchorLen = "";
		ctx.log(
			`old_string on ${file} is not a string — anchor dropped, whole file claimed`,
		);
	}
	let newIds = "";
	if ((neu != null && typeof neu !== "string") || anchorLen === "")
		ctx.log(
			`new_string on ${file} could not be read — entry ids dropped, allocation unchecked`,
		);
	else {
		const had = new Set(entryIds(typeof old === "string" ? old : ""));
		newIds = [
			...new Set(
				entryIds(typeof neu === "string" ? neu : "").filter(
					(id) => !had.has(id),
				),
			),
		]
			.sort()
			.slice(0, NEW_IDS_MAX)
			.join(",");
	}
	return { anchor, anchorLen, newIds };
}

/**
 * @param {Record<string, unknown>} out
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function relay(out, ctx) {
	const hso = /** @type {Record<string, unknown>} */ (
		out.hookSpecificOutput && typeof out.hookSpecificOutput === "object"
			? out.hookSpecificOutput
			: {}
	);
	const dropped = Object.keys(out).filter((k) => k !== "hookSpecificOutput");
	const said = hso.additionalContext;
	for (const k of Object.keys(hso))
		if (!["hookEventName", "additionalContext"].includes(k))
			dropped.push(`hookSpecificOutput.${k}`);
	if (dropped.length > 0)
		ctx.log(
			`arbiter answered fields a dispatcher part cannot carry — dropped: ${dropped.join(", ")}`,
		);
	return typeof said === "string" && said
		? { context: ctx.corePaths(said) }
		: null;
}

/**
 * @param {string} stdout
 * @param {FileClaimContext} ctx
 * @returns {{ note: string } | { decision: Decision }}
 */
function readAnswer(stdout, ctx) {
	if (!stdout.trim()) return { note: "" };
	let out;
	try {
		out = JSON.parse(stdout);
	} catch {
		ctx.log(
			"arbiter answered output that is not JSON — write allowed unchecked",
		);
		return { decision: null };
	}
	if (!out || typeof out !== "object" || Array.isArray(out)) {
		ctx.log(
			"arbiter answered output that is not a hook object — write allowed unchecked",
		);
		return { decision: null };
	}
	const hso = out.hookSpecificOutput;
	const isNote =
		Object.keys(out).join() === "hookSpecificOutput" &&
		hso &&
		typeof hso === "object" &&
		Object.keys(hso).sort().join() === "additionalContext,hookEventName" &&
		hso.hookEventName === "PreToolUse" &&
		typeof hso.additionalContext === "string";
	if (isNote) return { note: ctx.corePaths(hso.additionalContext) };
	return { decision: relay(out, ctx) };
}

/**
 * @param {string} rel
 * @param {FileClaimContext} ctx
 * @param {import("./guard-host-ports.js").TreePorts} tree
 */
function readAuthorityClass(rel, ctx, tree) {
	try {
		const text = throwUnreadable(tree.read(CLASSES));
		if (text === null) return "";
		const reg = JSON.parse(text);
		if (!reg || typeof reg !== "object" || Array.isArray(reg))
			throw new Error("the register is not a JSON object");
		const row = reg[rel];
		if (row == null) return "";
		if (typeof row !== "object")
			throw new Error(`its ${rel} row is not an object`);
		const q = row.classQualifier ?? "";
		if (typeof q !== "string" && q !== false)
			throw new Error(`its ${rel} classQualifier is not a string`);
		if (q && !/^\s*$/.test(q)) return "";
		return typeof row.class === "string" ? row.class : "";
	} catch (e) {
		ctx.log(
			`could not read ${tree.root}/${CLASSES} — authority class of ${rel} unchecked: ${caught(e).message}`,
		);
		return "";
	}
}

/**
 * @param {string} file
 * @param {FileClaimContext} ctx
 * @param {string} tree
 * @returns {{ note: string } | { decision: Decision }}
 */
function arbiterAnswer(file, ctx, tree) {
	const { anchor, anchorLen, newIds } = editFields(file, ctx);
	const session = ctx.session || ctx.env.CLAUDE_CODE_SESSION_ID || "";
	const arb = ctx.arbiterCheck(
		["check", file, session, anchor, anchorLen, newIds],
		tree,
	);
	if (arb.ok) return readAnswer(arb.stdout, ctx);
	ctx.log(`arbiter ${arb.why} on ${file} — write allowed unchecked`);
	const said = readAnswer(arb.stdout, ctx);
	if ("decision" in said) return said;
	return { decision: said.note ? { context: said.note } : null };
}

/**
 * @param {string} rel
 * @param {{ agentDoc: boolean, cls: string }} kind
 * @param {string} note
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function docsRules(rel, { agentDoc, cls }, note, ctx) {
	return {
		prelude: note,
		skip: [
			...(agentDoc ? [] : ["writing-for-agents"]),
			...(rel === "docs/reference-roadmap.html" ? [] : ["roadmap-edit"]),
			...ruleModule(ctx, "roadmap", ["roadmap-edit"]),
			...(rel === "docs/operating-manual.md" ? [] : ["manual-sync"]),
			...ruleModule(ctx, "governance", ["manual-sync"]),
			...ruleModule(ctx, "roadmap", ["manual-sync"]),
			...(cls === "derived" || cls === "generated-only"
				? []
				: ["doc-authority-class"]),
		],
		injectRules: [
			"writing-for-agents",
			"roadmap-edit",
			"manual-sync",
			"doc-authority-class",
			"claim-bash-route",
			"file-claim",
			"claim-release",
		],
	};
}

/**
 * @param {string} rel
 * @param {boolean} agentDoc
 * @param {boolean} creating
 * @param {string} note
 * @returns {Decision}
 */
function scriptRules(rel, agentDoc, creating, note) {
	if (
		creating &&
		/^scripts\/guard-[^/]+\.(?:sh|js)$/.test(rel) &&
		!JS_TEST_FILE.test(rel)
	)
		return {
			prelude: note,
			injectRules: [
				"guard-authoring",
				"script-self-claim",
				"claim-bash-route",
				"file-claim",
				"claim-release",
			],
		};
	return {
		prelude: note,
		skip: agentDoc ? [] : ["writing-for-agents"],
		injectRules: [
			"writing-for-agents",
			"script-self-claim",
			"claim-bash-route",
			"file-claim",
			"claim-release",
		],
	};
}

/**
 * @param {string} file
 * @param {FileClaimContext} ctx
 * @returns {Decision}
 */
function decide(file, ctx) {
	const creating = ctx.tool === "Write" && !ctx.exists(file);
	/* #4242, #4397 */
	const tree = treeOrHost(ctx);
	const rel = (relativeUnder(tree.root, file) || file).replace(/^\.\//, "");
	if (isScratch(rel)) return null;
	const answer = arbiterAnswer(file, ctx, tree.root);
	if ("decision" in answer) return answer.decision;
	const { note } = answer;
	const agentDoc =
		/^\.(?:claude|agents)\/skills\//.test(rel) ||
		/(?:^|\/)(?:CLAUDE|AGENTS)\.md$/.test(rel);
	if (/^(?:docs|\.claude)\//.test(rel) || /^(?:CLAUDE|AGENTS)\.md$/.test(rel))
		return docsRules(
			rel,
			{ agentDoc, cls: readAuthorityClass(rel, ctx, tree) },
			note,
			ctx,
		);
	if (rel.startsWith("scripts/"))
		return scriptRules(rel, agentDoc, creating, note);
	if (agentDoc) return { prelude: note, injectRules: ["writing-for-agents"] };
	return note ? { context: note } : null;
}

module.exports = {
	field: ["file_path", "notebook_path"],
	noun: "write",
	decide,
};
