/*
 * hook-escape.js — the guard-hook-escape core (#2801, #3225): a git-hook escape is
 * the founder's to set, never an agent's (#916, applying mantahostels#109's
 * "an escape a session can spell for itself is not a deny" to the git-hook
 * escapes).
 *
 * THE HOLE IT CLOSES. Two pre-commit gates each stand down for one commit on
 * an environment variable — WFC_ALLOW_BRANCH (.husky/pre-commit's main-checkout
 * branch check) and WFC_ALLOW_GATE_INPUT_DELETE (scripts/lib/precommit-gate.sh).
 * `WFC_ALLOW_NEW_PACKAGE` is guard-npm-install's and out of scope.
 *
 * A DENY, NOT A WARN: an assignment of a named variable is a structured fact
 * (mantahostels#103).
 *
 * WHAT IT REFUSES, read off walkCommands' commands:
 *  - a leading assignment of one (`WFC_ALLOW_BRANCH=1 git commit …`, `+=`
 *    too), whatever the command;
 *  - one carried by `env`, or standing after `sudo` and the other launchers
 *    unwrap strips (`sudo WFC_ALLOW_BRANCH=1 git …`);
 *  - `export` naming one, with or without a value, and `declare`/`typeset`
 *    doing so under an `x` flag.
 *
 * Its lib/guard-cores.json row runs it only on a call `if: Bash(*WFC_ALLOW_*)`
 * admits (#3225).
 *
 * LIMITS — lexical, and a Bash PreToolUse hook sees one command string:
 *  - an assignment-only segment (`WFC_ALLOW_BRANCH=1; git commit …`) is
 *    skipped by the walker. Unexported, it reaches no hook — unless `set -a`
 *    is on, or an `export` of it on a LATER call, which is refused;
 *  - an export made on an earlier Bash call persists, if the harness keeps
 *    the shell's environment, and a later bare `git commit` carries it unseen;
 *  - `sh -c "…"`, `bash -c "…"`, `eval`, a heredoc and a wrapper script all
 *    hide the assignment inside a quoted span or another file;
 *  - an UNQUOTED command-substitution value, `NAME=$(…) git commit`: the
 *    splitter cuts the substitution out, and the walker never reaches the
 *    assignment. The quoted `NAME="$(…)"` is refused;
 *  - a variable set by a script the command runs, and anything typed outside
 *    Claude Code, which is the founder's route by design.
 */

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
		"A git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (#916)",
	);
	return denyText(ctx, segment, `${FRAMING}\n\n${rule}`);
}

module.exports = { field: "command", noun: "command", decide };
