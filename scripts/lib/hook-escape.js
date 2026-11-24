const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");

const ESCAPE_NAMES = "WFC_ALLOW_BRANCH|WFC_ALLOW_GATE_INPUT_DELETE";

const MENTION_RE = new RegExp(
	`(^|[^A-Za-z0-9_])(${ESCAPE_NAMES})([^A-Za-z0-9_]|$)`,
);
const ASSIGNS_RE = new RegExp(`^(${ESCAPE_NAMES})\\+?=`);
const NAMES_RE = new RegExp(`^(${ESCAPE_NAMES})(\\+?=|$)`);
const QUOTED_OR_ESCAPED_RE = /'[^']*'?|"(?:\\[\s\S]?|[^"\\])*"?|\\[\s\S]?/g;
const EXPORTERS = ["export", "declare", "typeset"];
const ASSIGNMENT_RE = /^[A-Za-z_].*=/s;

const FRAMING = "This command sets a git-hook escape: @CMD@";

/**
 * @typedef {import("./kit-context.js").KitContext} HookEscapeContext
 */

/**
 * @param {string} command
 * @param {HookEscapeContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	if (!MENTION_RE.test(unquotedText(command))) return null;
	const parsed = parseCommand(command);
	/** @type {string | null} */
	let refused = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (refused === null && setsEscape(cmd)) refused = cmd.segment;
		},
		ctx,
	);
	return refused === null ? null : { deny: refusalText(refused, ctx) };
}

/** @param {string} s */
function unquotedText(s) {
	return s.replace(QUOTED_OR_ESCAPED_RE, " ");
}

/** @param {import("./shell-parse.js").Command} cmd */
function setsEscape({ leading, runs }) {
	if (leading.some((w) => ASSIGNS_RE.test(w))) return true;
	return runs().some(
		({ words: run, wrapperWords }) =>
			leadingSets(wrapperWords) ||
			(run.length > 0 && (leadingSets(run) || exportsEscape(run))),
	);
}

/** @param {string[]} words */
function leadingSets(words) {
	for (const w of words) {
		if (!ASSIGNMENT_RE.test(w)) return false;
		if (ASSIGNS_RE.test(w)) return true;
	}
	return false;
}

/** @param {string[]} run */
function exportsEscape(run) {
	const head = run[0] ?? "";
	const cmd = head.slice(head.lastIndexOf("/") + 1);
	if (!EXPORTERS.includes(cmd)) return false;
	let exporting = cmd === "export";
	for (const w of run.slice(1))
		if (w.startsWith("-")) exporting = flagExports(w, exporting);
		else if (exporting && NAMES_RE.test(w)) return true;
	return false;
}

/**
 * @param {string} w
 * @param {boolean} exporting
 */
const flagExports = (w, exporting) =>
	w.includes("x") || (exporting && !w.includes("n"));

/**
 * @param {string} segment
 * @param {HookEscapeContext} ctx
 */
function refusalText(segment, ctx) {
	const rule = ruleOrFallback(
		ctx,
		"hook-escape",
		"A git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (workflow-core#916)",
	);
	return denyText(ctx, segment, `${FRAMING}\n\n${rule}`);
}

module.exports = { field: "command", noun: "command", decide };
