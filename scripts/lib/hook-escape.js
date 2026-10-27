/*
 * hook-escape.js — guard-hook-escape.js's core (#2801): a git-hook escape is
 * the founder's to set, never an agent's (#916, applying mantahostels#109's
 * "an escape a session can spell for itself is not a deny" to the git-hook
 * escapes).
 *
 * THE HOLE IT CLOSES. Two pre-commit gates each stand down for one commit on
 * an environment variable — WFC_ALLOW_BRANCH (.husky/pre-commit's shared-tree
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

const { denyText, ruleOr } = require("./guard-verdict.js");
const { parseCommand, walkCommands } = require("./shell-parse.js");
const { unwrap } = require("./shell-words.js");

const ESCAPE_NAMES = "WFC_ALLOW_BRANCH|WFC_ALLOW_GATE_INPUT_DELETE";

/* An escape name standing outside every quote, as a whole word. */
const MENTION_RE = new RegExp(
	`(^|[^A-Za-z0-9_])(${ESCAPE_NAMES})([^A-Za-z0-9_]|$)`,
);
/* One word assigning an escape (`NAME=…`, `NAME+=…`). */
const ASSIGNS_RE = new RegExp(`^(${ESCAPE_NAMES})\\+?=`);
/* One argument of `export`/`declare` naming an escape, value or none. */
const NAMES_RE = new RegExp(`^(${ESCAPE_NAMES})(\\+?=|$)`);
/* A quoted span, to its close or the end of the text, or one escaped
 * character: a backslash is literal inside single quotes, escapes the next
 * character inside double quotes, and outside both escapes a quote rather
 * than opening one. */
const QUOTED_OR_ESCAPED_RE = /'[^']*'?|"(?:\\[\s\S]?|[^"\\])*"?|\\[\s\S]?/g;
/* What reads an escape's name as an export: `export`, and `declare`/`typeset`
 * under an `x` flag. */
const EXPORTERS = ["export", "declare", "typeset"];
/* A word shaped as an assignment, which a leading run is made of. */
const ASSIGNMENT_RE = /^[A-Za-z_].*=/s;

const ESCAPE_RULE_FALLBACK =
	"A git-hook WFC_ALLOW_* escape is the founder's to set, never an agent's (#916); the rule could not be read from docs/agents/rules/hook-escape.txt. Read that file before doing anything else.";

const FRAMING = "This command sets a git-hook escape: @CMD@";

/**
 * @typedef {import("./guard-entry.js").KitContext} HookEscapeContext
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
		({ segment, words, leading }) => {
			if (refused === null && setsEscape(leading, words, parsed.spans))
				refused = segment;
		},
		ctx,
	);
	return refused === null ? null : { deny: refusalText(refused, ctx) };
}

/**
 * The subject with every quoted span blanked, read quote-aware across
 * newlines. The splitter masks a quoted span per line, so a single-quoted
 * mention running over a line break — the founder's command written into
 * `gh … --body '…'` — would otherwise reach the walk as live words and be
 * refused.
 * @param {string} s
 */
function unquotedText(s) {
	return s.replace(QUOTED_OR_ESCAPED_RE, " ");
}

/**
 * Whether one command sets an escape: in its own leading assignments, which
 * the walk strips from `words`; among the assignments an `env` carried; or in
 * the leading run unwrap leaves, which it stops on at once where the words
 * open with one — a word after `exec` is the command to shell, yet `exec
 * NAME=1 git …` is refused all the same — and stops on after `sudo` (`sudo
 * NAME=1 cmd`) and on one inside `env` whose value holds a `/` (`env
 * PATH=/usr/bin NAME=1 cmd`), reading it by basename; or as an
 * `export`/`declare -x` argument.
 * @param {string[]} leading
 * @param {string[]} words
 * @param {string[]} spans
 */
function setsEscape(leading, words, spans) {
	if (leading.some((w) => ASSIGNS_RE.test(w))) return true;
	const { words: run, wrapperWords } = unwrap(words, spans);
	if (leadingSets(wrapperWords)) return true;
	if (run.length === 0) return false;
	return leadingSets(run) || exportsEscape(run);
}

/**
 * Whether an assignment among the words' leading run sets an escape.
 * @param {string[]} words
 */
function leadingSets(words) {
	for (const w of words) {
		if (!ASSIGNMENT_RE.test(w)) return false;
		if (ASSIGNS_RE.test(w)) return true;
	}
	return false;
}

/**
 * Whether an `export`, or a `declare`/`typeset` under an `x` flag, names an
 * escape. `export -n` takes the export away.
 * @param {string[]} run the unwrapped words, the command first
 */
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
 * Whether a flag word leaves the names after it exported: its `n` is read
 * first, then its `x`, so a word carrying both exports.
 * @param {string} w
 * @param {boolean} exporting
 */
const flagExports = (w, exporting) =>
	w.includes("x") || (exporting && !w.includes("n"));

/**
 * @param {string} segment masked
 * @param {HookEscapeContext} ctx
 */
function refusalText(segment, ctx) {
	const rule = ruleOr(() => ctx.ruleText("hook-escape"), ESCAPE_RULE_FALLBACK);
	return denyText(ctx, segment, `${FRAMING}\n\n${rule}`);
}

module.exports = { decide };
