const { basename } = require("node:path").posix;
const { noop } = require("./noop.js");

const REJECTED = "[rejected]";
const FETCH_FIRST = "fetch first";
const NON_FAST_FORWARD = "non-fast-forward";

const MARKERS = [
	"Not possible to fast-forward",
	"Need to specify how to reconcile divergent branches",
	"Updates were rejected because",
	NON_FAST_FORWARD,
	`! ${REJECTED}`,
	FETCH_FIRST,
];

/**
 * @typedef {object} DivergencePorts
 * @property {boolean} disabled
 * @property {(payload: Record<string, unknown>) => string} sessionDir
 * @property {(p: string) => boolean} isDir
 * @property {(dir: string) => string | null} toplevel
 * @property {(dir: string) => string | null} commonDir
 * @property {(top: string) => string} pushedRef
 * @property {(top: string, ref: string) => boolean} refExists
 * @property {(top: string) => string | null} upstream
 * @property {(top: string, ref: string) => string | null} counts
 * @property {() => number | null} sessions
 * @property {() => Date} now
 * @property {(top: string) => string} projectDir
 * @typedef {{ dir: string, file: string, line: string }} Row
 */

const isPresent = (/** @type {unknown} */ v) =>
	v !== undefined && v !== null && v !== false;

/** @param {Record<string, unknown>} payload */
function outputOf(payload) {
	const v =
		[payload.tool_output, payload.tool_response, payload.error].find(
			isPresent,
		) ?? payload;
	return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {(p: string) => boolean} isDir
 * @returns {{ kind: string, tree: string } | null}
 */
function firstRefusable(command, cwd, isDir) {
	const { parseCommand, walkGit } = require("./shell-parse.js");
	/** @type {{ kind: string, tree: string } | null} */
	let found = null;
	walkGit(
		parseCommand(command),
		({ sub, tree }) => {
			found ??= { kind: sub, tree };
		},
		{
			cwd: undefined,
			fallbackCwd: cwd,
			vars: {},
			isDir,
			treeClass: () => "shared",
			log: noop,
		},
		{
			subs: ["pull", "push"],
			noun: "divergence row",
			scope: "repo",
			strict: true,
		},
	);
	return found;
}

/**
 * @param {string} top
 * @param {string} common
 */
function repoName(top, common) {
	const repo = basename(common.replace(/\/\.git$/, "").replace(/\/$/, ""));
	return repo || basename(top);
}

/** @param {string | null} counts */
function readCounts(counts) {
	const m = /^([0-9]+)[ \t\n\v\f\r]+([0-9]+)$/.exec(counts ?? "");
	if (!m) return { ahead: "-", behind: "-", state: "unknown" };
	const [, ahead = "", behind = ""] = m;
	const a = Number(ahead) > 0;
	const b = Number(behind) > 0;
	let state = "level";
	if (a && b) state = "diverged";
	else if (b) state = "behind";
	else if (a) state = "ahead";
	return { ahead, behind, state };
}

/** @param {string} s */
const flat = (s) => s.replace(/[\t\r\n]/g, " ");

/**
 * @param {unknown} payload
 * @returns {{ command: string, marker: string,
 *   payload: Record<string, unknown> } | null}
 */
function readRefusal(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return null;
	const p = /** @type {Record<string, unknown>} */ (payload);
	if (p.tool_name !== "Bash") return null;
	const input = /** @type {Record<string, unknown> | null} */ (
		p.tool_input && typeof p.tool_input === "object" ? p.tool_input : null
	);
	const command = input?.command;
	if (typeof command !== "string" || !command) return null;
	const marker = markerIn(outputOf(p));
	return marker ? { command, marker, payload: p } : null;
}

/** @param {string} out */
const markerIn = (out) => MARKERS.find((m) => out.includes(m));

/**
 * @param {string} top
 * @param {DivergencePorts} ports
 */
function countedRef(top, ports) {
	const pushed = ports.pushedRef(top);
	if (pushed && ports.refExists(top, pushed)) return pushed;
	return ports.upstream(top) ?? "";
}

/**
 * @param {unknown} payload
 * @param {DivergencePorts} ports
 * @returns {Row | null}
 */
function divergenceRow(payload, ports) {
	if (ports.disabled) return null;
	const refusal = readRefusal(payload);
	if (!refusal) return null;
	const call = firstRefusable(
		refusal.command,
		ports.sessionDir(refusal.payload),
		ports.isDir,
	);
	if (!call?.tree) return null;
	return rowAt(call.tree, call.kind, refusal.marker, ports);
}

/**
 * @param {string} tree
 * @param {string} output
 * @param {DivergencePorts} ports
 * @returns {Row | null}
 */
function landRow(tree, output, ports) {
	if (ports.disabled) return null;
	const marker = markerIn(output);
	return marker ? rowAt(tree, "land", marker, ports) : null;
}

/**
 * @param {string} tree
 * @param {string} kind
 * @param {string} marker
 * @param {DivergencePorts} ports
 * @returns {Row | null}
 */
function rowAt(tree, kind, marker, ports) {
	const top = ports.toplevel(tree);
	if (!top) return null;

	const ref = countedRef(top, ports);
	const { ahead, behind, state } = readCounts(
		ref ? ports.counts(top, ref) : null,
	);
	const n = ports.sessions();
	const when = `${ports.now().toISOString().slice(0, 19)}.000Z`;
	const fields = [
		when,
		flat(repoName(top, ports.commonDir(tree) ?? "")),
		kind,
		ahead,
		behind,
		state,
		n === null ? "-" : String(n),
		flat(ref || "-"),
		flat(marker),
	];
	const dir = ports.projectDir(top);
	return { dir, file: `${dir}/divergence.log`, line: `${fields.join("\t")}\n` };
}

module.exports = {
	divergenceRow,
	FETCH_FIRST,
	landRow,
	NON_FAST_FORWARD,
	REJECTED,
};
